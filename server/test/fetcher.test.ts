import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetcher } from "../src/services/fetcher.js";
import { isBlockedIp } from "../src/security/url.js";

// A local test server stands in for a public site. The fetcher's policy exempts
// 127.0.0.1 only for these tests; every other address uses the real blocklist.
let server: http.Server;
let port: number;

const DNS: Record<string, LookupAddress[]> = {
  "site.test": [{ address: "127.0.0.1", family: 4 }],
  "other.test": [{ address: "127.0.0.1", family: 4 }],
  "internal.test": [{ address: "10.0.0.5", family: 4 }],
  "rebind.test": [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ],
  "v6internal.test": [{ address: "fd00::1", family: 6 }],
};

function fetcher(overrides = {}) {
  return createSafeFetcher({
    allowedPorts: [port],
    isBlockedIp: (ip) => ip !== "127.0.0.1" && isBlockedIp(ip),
    resolve: async (host) => {
      const hit = DNS[host];
      if (!hit) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      return hit;
    },
    timeoutMs: 1500,
    maxBytes: 10_000,
    ...overrides,
  });
}

const u = (host: string, path = "/") => `http://${host}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    const redirect = (to: string) => res.writeHead(302, { location: to }).end();
    switch (path) {
      case "/":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Hello</h1>");
        return;
      case "/json":
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      case "/big":
        res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(20_000));
        return;
      case "/big-chunked":
        res.writeHead(200, { "content-type": "text/html" });
        for (let i = 0; i < 20; i++) res.write("y".repeat(1000));
        res.end();
        return;
      case "/slow":
        setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("late"), 3000);
        return;
      case "/gzip":
        res
          .writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
          .end(zlib.gzipSync("<h1>Compressed hello</h1>"));
        return;
      case "/brotli":
        res
          .writeHead(200, { "content-type": "text/html", "content-encoding": "br" })
          .end(zlib.brotliCompressSync("<h1>Brotli hello</h1>"));
        return;
      case "/gzip-bomb":
        res
          .writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
          .end(zlib.gzipSync(Buffer.alloc(5_000_000, 32)));
        return;
      case "/weird-encoding":
        res.writeHead(200, { "content-type": "text/html", "content-encoding": "zstd-x" }).end("??");
        return;
      case "/latin1":
        res
          .writeHead(200, { "content-type": "text/html; charset=ISO-8859-1" })
          .end(Buffer.from("<p>Café</p>", "latin1"));
        return;
      case "/404":
        res.writeHead(404, { "content-type": "text/html" }).end("nope");
        return;
      case "/to-ok":
        return redirect(u("other.test", "/"));
      case "/to-relative":
        return redirect("/");
      case "/to-internal-name":
        return redirect(u("internal.test", "/"));
      case "/to-metadata":
        return redirect("http://169.254.169.254/latest/meta-data/");
      case "/to-loopback-v6":
        return redirect(`http://[::1]:${port}/`);
      case "/to-file":
        return redirect("file:///etc/passwd");
      case "/to-bad-port":
        return redirect("http://site.test:6379/");
      case "/loop":
        return redirect("/loop");
      case "/no-location":
        res.writeHead(302).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("createSafeFetcher", () => {
  it("fetches an HTML page", async () => {
    const page = await fetcher()(u("site.test"));
    expect(page.html).toContain("Hello");
    expect(page.url).toBe(u("site.test"));
  });

  it("follows safe redirects and reports the final URL", async () => {
    expect((await fetcher()(u("site.test", "/to-ok"))).url).toBe(u("other.test"));
    expect((await fetcher()(u("site.test", "/to-relative"))).url).toBe(u("site.test"));
  });

  it.each([
    ["/to-internal-name", "BLOCKED_URL"],
    ["/to-metadata", "BLOCKED_URL"],
    ["/to-loopback-v6", "BLOCKED_URL"],
    ["/to-file", "INVALID_URL"],
    ["/to-bad-port", "BLOCKED_URL"],
    ["/loop", "FETCH_FAILED"],
    ["/no-location", "FETCH_FAILED"],
  ])("re-validates redirect %s", async (path, code) => {
    await expect(fetcher()(u("site.test", path))).rejects.toMatchObject({ code });
  });

  it("blocks hosts that resolve to private addresses", async () => {
    await expect(fetcher()(u("internal.test"))).rejects.toMatchObject({ code: "BLOCKED_URL" });
    await expect(fetcher()(u("v6internal.test"))).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("blocks a host if ANY resolved address is private (DNS rebinding)", async () => {
    await expect(fetcher()(u("rebind.test"))).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("uses the real blocklist by default (loopback is refused)", async () => {
    const strict = createSafeFetcher({
      allowedPorts: [port],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    await expect(strict(u("site.test"))).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  it("rejects non-HTML content", async () => {
    await expect(fetcher()(u("site.test", "/json"))).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" });
  });

  it("enforces the response size limit (declared and streamed)", async () => {
    await expect(fetcher()(u("site.test", "/big"))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    await expect(fetcher()(u("site.test", "/big-chunked"))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("decompresses gzip and brotli responses", async () => {
    expect((await fetcher()(u("site.test", "/gzip"))).html).toBe("<h1>Compressed hello</h1>");
    expect((await fetcher()(u("site.test", "/brotli"))).html).toBe("<h1>Brotli hello</h1>");
  });

  it("applies the size limit after decompression (compression bomb)", async () => {
    await expect(fetcher()(u("site.test", "/gzip-bomb"))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("rejects unknown content encodings", async () => {
    await expect(fetcher()(u("site.test", "/weird-encoding"))).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT",
    });
  });

  it("decodes the declared charset", async () => {
    expect((await fetcher()(u("site.test", "/latin1"))).html).toBe("<p>Café</p>");
  });

  it("times out slow responses", async () => {
    await expect(fetcher({ timeoutMs: 300 })(u("site.test", "/slow"))).rejects.toMatchObject({
      code: "FETCH_TIMEOUT",
    });
  });

  it("maps HTTP errors and DNS failures", async () => {
    await expect(fetcher()(u("site.test", "/404"))).rejects.toMatchObject({ code: "FETCH_FAILED" });
    await expect(fetcher()(u("missing.test"))).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });
});
