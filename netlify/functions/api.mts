/**
 * Netlify Functions adapter for the existing Express API (server/src/app.ts).
 *
 * The Express app is started once per function instance on a loopback port, and
 * each /api/* request is forwarded to it. All routes, middleware, upload handling,
 * SSRF protection and error handling are reused unchanged.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../server/src/app.js";
import { loadConfig } from "../../server/src/config.js";

/** Subset of Netlify's function Context used here. */
interface NetlifyContext {
  ip?: string;
}

// Defaults sized for Netlify's limits: although synchronous functions may run 60 s,
// Netlify's proxy returns a 504 to the browser after ~26 s (10 s on some plans).
// Requests are buffered up to 6 MB (Base64-encoded uploads ≈ 4.5 MB of file).
// Site environment variables override them. Worst case: 4 s homepage + 1 batch
// × 4 s pages + 16 s AI (including any JSON retry) ≈ 24 s. REQUEST_TIMEOUT_MS also
// caps the total, so slow upload parsing or crawling shortens the AI budget instead
// of pushing the request past the gateway and into a bare 504.
const NETLIFY_DEFAULTS = {
  MAX_UPLOAD_MB: "4",
  MAX_PAGES: "3",
  FETCH_TIMEOUT_MS: "4000",
  LLM_TIMEOUT_MS: "16000",
  REQUEST_TIMEOUT_MS: "24000",
};

// Site variables may lower these but never raise them past the gateway budget,
// e.g. values copied from .env.example (MAX_PAGES=8, LLM_TIMEOUT_MS=180000).
const NETLIFY_MAX: Record<keyof typeof NETLIFY_DEFAULTS, number> = {
  MAX_UPLOAD_MB: 4,
  MAX_PAGES: 3,
  FETCH_TIMEOUT_MS: 4000,
  LLM_TIMEOUT_MS: 16000,
  REQUEST_TIMEOUT_MS: 24000,
};

export function netlifyEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...NETLIFY_DEFAULTS, ...env };
  for (const [key, max] of Object.entries(NETLIFY_MAX) as [keyof typeof NETLIFY_MAX, number][]) {
    const value = Number(out[key]);
    out[key] = String(Number.isFinite(value) && value > 0 ? Math.min(value, max) : max);
  }
  return out;
}

// Headers that must not be forwarded as-is to the loopback server.
const DROP_REQUEST_HEADERS = [
  "connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded",
];
const DROP_RESPONSE_HEADERS = ["connection", "keep-alive", "transfer-encoding", "content-encoding"];

let origin: Promise<string> | undefined;

function startServer(): Promise<string> {
  origin ??= new Promise<string>((resolve, reject) => {
    const config = loadConfig({
      ...netlifyEnv(process.env),
      // Only this adapter talks to the server, and it sets X-Forwarded-For itself.
      TRUST_PROXY: "loopback",
    });
    const server = http.createServer(createApp({ config }));
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  }).catch((err) => {
    origin = undefined; // allow a retry on the next invocation
    throw err;
  });
  return origin;
}

export default async function handler(req: Request, context: NetlifyContext): Promise<Response> {
  const base = await startServer();
  const url = new URL(req.url);
  // netlify.toml rewrites /api/* to /.netlify/functions/api/*; Express serves /api/*.
  const pathname = url.pathname.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, "/api");

  const headers = new Headers(req.headers);
  for (const h of DROP_REQUEST_HEADERS) headers.delete(h);
  // Netlify's context.ip is the verified client address; used for rate limiting.
  if (context?.ip) headers.set("x-forwarded-for", context.ip);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const upstream = await fetch(`${base}${pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    redirect: "manual",
  });

  const out = new Headers(upstream.headers);
  for (const h of DROP_RESPONSE_HEADERS) out.delete(h);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
