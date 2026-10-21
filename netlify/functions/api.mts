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
// × 4 s pages + 16 s AI (including any JSON retry) ≈ 24 s.
const NETLIFY_DEFAULTS = {
  MAX_UPLOAD_MB: "4",
  MAX_PAGES: "3",
  FETCH_TIMEOUT_MS: "4000",
  LLM_TIMEOUT_MS: "16000",
};

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
      ...NETLIFY_DEFAULTS,
      ...process.env,
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
