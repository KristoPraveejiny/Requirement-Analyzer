import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { pipeline, type Readable, type Transform } from "node:stream";
import zlib from "node:zlib";
import { Agent, request } from "undici";
import { AppError } from "../errors.js";
import { blockedError, isBlockedIp, validatePublicUrl, type UrlPolicy } from "../security/url.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPES = ["text/html", "application/xhtml+xml"];

export interface FetchOptions extends UrlPolicy {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** DNS resolver; injectable for tests. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
}

export interface FetchedPage {
  /** Final URL after redirects. */
  url: string;
  html: string;
}

export type PageFetcher = (url: string) => Promise<FetchedPage>;

const defaultResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Creates a fetcher that only talks to public hosts. Every connection resolves
 * DNS itself, rejects the host if ANY resolved address is non-public, and pins
 * the socket to a validated address (closes the DNS-rebinding TOCTOU gap).
 * Redirects are followed manually and every hop is re-validated.
 */
export function createSafeFetcher(options: FetchOptions = {}): PageFetcher {
  const {
    timeoutMs = 10_000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 3,
    resolve = defaultResolve,
  } = options;
  const blocked = options.isBlockedIp ?? isBlockedIp;
  const policy: UrlPolicy = { isBlockedIp: blocked, allowedPorts: options.allowedPorts };

  const safeLookup = (hostname: string, opts: { all?: boolean }, callback: LookupCallback) => {
    resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0 || addresses.some((a) => blocked(a.address))) {
          throw blockedError();
        }
        if (opts?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      })
      .catch((err) => callback(err, ""));
  };

  const dispatcher = new Agent({
    connect: { lookup: safeLookup, timeout: timeoutMs } as Agent.Options["connect"],
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: 4,
  });

  return async function fetchPage(input: string): Promise<FetchedPage> {
    let url = validatePublicUrl(input, policy);
    const signal = AbortSignal.timeout(timeoutMs);

    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await request(url, {
          method: "GET",
          dispatcher,
          signal,
          headers: {
            "user-agent": "VoiceAgentRequirementsBot/0.1 (+requirements analysis)",
            accept: "text/html,application/xhtml+xml;q=0.9",
            "accept-encoding": "gzip, deflate, br",
          },
        });
      } catch (err) {
        throw toFetchError(err);
      }

      if (REDIRECT_STATUSES.has(res.statusCode)) {
        await discard(res.body);
        const location = res.headers.location;
        if (typeof location !== "string" || !location) {
          throw new AppError("FETCH_FAILED", "The website returned a redirect without a location.", 502);
        }
        if (hop >= maxRedirects) {
          throw new AppError("FETCH_FAILED", "The website redirected too many times.", 502);
        }
        url = validatePublicUrl(new URL(location, url).toString(), policy);
        continue;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        await discard(res.body);
        throw new AppError("FETCH_FAILED", `The website responded with HTTP ${res.statusCode}.`, 502);
      }

      const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
      if (!HTML_TYPES.some((t) => contentType.startsWith(t))) {
        await discard(res.body);
        throw new AppError("UNSUPPORTED_CONTENT", "The URL did not return an HTML page.", 422);
      }

      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await discard(res.body);
        throw tooLarge();
      }

      // Servers may compress even when not asked; the size cap applies to the
      // decompressed bytes so a small compressed bomb can't exhaust memory.
      const encoding = String(res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      const decompressor = createDecompressor(encoding);
      if (decompressor === undefined) {
        await discard(res.body);
        throw new AppError("UNSUPPORTED_CONTENT", "The website used an unsupported content encoding.", 422);
      }
      const stream: Readable = decompressor ? pipeline(res.body, decompressor, () => {}) : res.body;

      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > maxBytes) {
            // Throwing ends the for-await, which destroys the stream (and pipeline upstream).
            throw tooLarge();
          }
          chunks.push(chunk);
        }
      } catch (err) {
        throw toFetchError(err);
      }

      return { url: url.toString(), html: decodeText(Buffer.concat(chunks), contentType) };
    }
  };
}

/** Releases a response body without emitting unhandled abort errors. */
function discard(body: { dump(opts?: { limit?: number }): Promise<void> }): Promise<void> {
  return body.dump({ limit: 0 }).catch(() => {});
}

/** null = no decoding needed; undefined = unsupported encoding. */
function createDecompressor(encoding: string): Transform | null | undefined {
  switch (encoding) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

function decodeText(buf: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf); // unknown charset label
  }
}

function tooLarge() {
  return new AppError("RESPONSE_TOO_LARGE", "The web page is too large to analyse.", 422);
}

function toFetchError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { name?: string; code?: string; cause?: unknown };
  if (e?.cause instanceof AppError) return e.cause;
  if (
    e?.name === "TimeoutError" ||
    e?.name === "AbortError" ||
    e?.code === "UND_ERR_HEADERS_TIMEOUT" ||
    e?.code === "UND_ERR_BODY_TIMEOUT" ||
    e?.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new AppError("FETCH_TIMEOUT", "The website took too long to respond.", 504);
  }
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") {
    return new AppError("FETCH_FAILED", "The website's domain could not be found.", 502);
  }
  return new AppError("FETCH_FAILED", "The website could not be reached.", 502);
}
