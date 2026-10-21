import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import handler from "../../netlify/functions/api.mjs";
import { sampleDocument } from "./helpers.js";

// Exercises the Netlify adapter end-to-end against the real Express app.
// No OPENROUTER_API_KEY is set in tests, so the app runs in mock mode.
const call = (path: string, init?: RequestInit, ip = "203.0.113.7") =>
  handler(new Request(`https://reqanalyze.netlify.app${path}`, init), { ip });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response) => (await r.json()) as any;

describe("Netlify function adapter", () => {
  it("serves the API under both /api/* and the rewritten function path", async () => {
    for (const path of ["/api/health", "/.netlify/functions/api/health"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ status: "ok", mock: true, maxUploadMb: 4 });
    }
  });

  it("keeps security headers and JSON 404s", async () => {
    const res = await call("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await json(res)).error.code).toBe("NOT_FOUND");
  });

  it("returns the claude prompt and a binary DOCX through the adapter", async () => {
    const post = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sampleDocument()) };
    const prompt = await call("/api/claude-prompt", post);
    expect((await json(prompt)).claudePrompt).toContain("## 1. OPENING");

    const docx = await call("/api/export/docx", post);
    expect(docx.status).toBe(200);
    expect(docx.headers.get("content-disposition")).toContain(".docx");
    const zip = await JSZip.loadAsync(Buffer.from(await docx.arrayBuffer()));
    expect(await zip.file("word/document.xml")!.async("string")).toContain("1. OPENING");
  });

  it("keeps SSRF protection and multipart upload validation", async () => {
    const blocked = new FormData();
    blocked.set("url", "http://169.254.169.254/latest/meta-data");
    const res = await call("/api/generate", { method: "POST", body: blocked });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("BLOCKED_URL");

    const spoofed = new FormData();
    spoofed.set("url", "https://example.com");
    spoofed.set("sample", new Blob(["not a pdf"]), "fake.pdf");
    const bad = await call("/api/generate", { method: "POST", body: spoofed });
    expect((await json(bad)).error.code).toBe("INVALID_UPLOAD");
  });

  it("enforces the Netlify-sized 4 MB upload limit", async () => {
    const form = new FormData();
    form.set("url", "https://example.com");
    form.set("sample", new Blob([new Uint8Array(4.5 * 1024 * 1024).fill(65)]), "big.txt");
    const res = await call("/api/generate", { method: "POST", body: form });
    expect(res.status).toBe(413);
    expect((await json(res)).error.code).toBe("FILE_TOO_LARGE");
  });

  it("rate-limits per client IP from the Netlify context, ignoring spoofed X-Forwarded-For", async () => {
    // Default limit is 10/min per IP; use invalid input so no network calls are made.
    const attempt = (ip: string, spoof?: string) => {
      const form = new FormData();
      form.set("url", "");
      return call("/api/generate", { method: "POST", body: form, headers: spoof ? { "x-forwarded-for": spoof } : {} }, ip);
    };
    for (let i = 0; i < 10; i++) expect((await attempt("198.51.100.1", `10.0.0.${i}`)).status).toBe(400);
    expect((await attempt("198.51.100.1", "10.9.9.9")).status).toBe(429);
    expect((await attempt("198.51.100.2")).status).toBe(400); // a different client is unaffected
  });
});
