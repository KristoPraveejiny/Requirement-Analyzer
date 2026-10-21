import JSZip from "jszip";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import type { PageFetcher } from "../src/services/fetcher.js";
import type { DraftGenerator } from "../src/types.js";
import { sampleDocument, sampleDraft, testConfig } from "./helpers.js";

const SITE: Record<string, string> = {
  "https://acme.test/": `<title>Acme Plumbing</title><main><h1>Acme Plumbing</h1>
    <p>Emergency plumbing and boiler repairs across Springfield. Family run since 1990, we handle leaks,
    blocked drains, boiler servicing and bathroom installs for homes and small businesses.</p>
    <a href="/contact">Contact</a></main>`,
  "https://acme.test/contact": "<main><p>Call us on 555-1234.</p></main>",
};
const fetchPage: PageFetcher = async (url) => {
  const html = SITE[url];
  if (!html) throw new AppError("FETCH_FAILED", "not found", 502);
  return { url, html };
};

function app(generateDraft?: DraftGenerator, env: Record<string, string> = {}) {
  return createApp({
    config: testConfig(env),
    fetchPage,
    generateDraft,
    now: () => new Date("2026-10-21T10:00:00Z"),
  });
}

describe("GET /api/health", () => {
  it("reports mock mode when no API key is set", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", mock: true, maxUploadMb: 5 });
  });

  it("sets security headers and hides x-powered-by", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("POST /api/generate", () => {
  it("crawls, generates and assembles a document", async () => {
    const gen = vi.fn<DraftGenerator>(async () => sampleDraft());
    const res = await request(app(gen)).post("/api/generate").field("url", "acme.test").field("mode", "voice-agent");

    expect(res.status).toBe(200);
    const input = gen.mock.calls[0][0];
    expect(input.pages.map((p) => p.url)).toEqual(["https://acme.test/", "https://acme.test/contact"]);
    expect(input.sample).toBeUndefined();
    expect(input).toMatchObject({ language: "auto", languageAlt: "English" });

    const { document, claudePrompt, mock } = res.body;
    expect(mock).toBe(false);
    expect(document.title).toBe("Acme Plomberie Script");
    expect(document.sections).toHaveLength(9);
    expect(document).toMatchObject({ language: "French", languageAlt: "English" });
    expect(document.generatedAt).toBe("2026-10-21T10:00:00.000Z");
    // Invented sources are dropped.
    expect(document.sourcesUsed).toEqual(["https://acme.test/"]);
    expect(claudePrompt).toContain("phone voice agent for Acme Plomberie");
  });

  it("passes an uploaded sample to the generator", async () => {
    const gen = vi.fn<DraftGenerator>(async () => sampleDraft());
    const res = await request(app(gen))
      .post("/api/generate")
      .field("url", "https://acme.test/")
      .field("mode", "voicemail")
      .field("language", "French")
      .field("languageAlt", "none")
      .attach("sample", Buffer.from("Sample greeting style"), "sample.txt");
    expect(res.status).toBe(200);
    expect(res.body.sampleUsed).toBe(true);
    expect(gen.mock.calls[0][0]).toMatchObject({
      mode: "voicemail",
      sample: "Sample greeting style",
      language: "French",
      languageAlt: null,
    });
    expect(res.body.document.sections[0].title).toBe("VOICEMAIL GREETING");
    expect(res.body.document.languageAlt).toBeNull();
  });

  it("works end-to-end in mock mode", async () => {
    const res = await request(app()).post("/api/generate").field("url", "https://acme.test/");
    expect(res.status).toBe(200);
    expect(res.body.mock).toBe(true);
    expect(res.body.document.contextLine).toContain("MOCK MODE");
  });

  it.each([
    [{ url: "http://169.254.169.254/" }, 400, "BLOCKED_URL"],
    [{ url: "ftp://acme.test" }, 400, "INVALID_URL"],
    [{ url: "" }, 400, "INVALID_URL"],
    [{ url: "https://acme.test/", mode: "fax" }, 400, "INVALID_INPUT"],
    [{ url: "https://acme.test/", language: "Klingon" }, 400, "INVALID_INPUT"],
  ])("rejects bad input %o", async (fields, status, code) => {
    const gen = vi.fn<DraftGenerator>();
    let req = request(app(gen)).post("/api/generate");
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    const res = await req;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(gen).not.toHaveBeenCalled();
  });

  it("rejects unsupported, spoofed and oversized uploads", async () => {
    const a = app(vi.fn<DraftGenerator>(), { MAX_UPLOAD_MB: "0.001" });
    const exe = await request(a).post("/api/generate").field("url", "acme.test").attach("sample", Buffer.from("MZ"), "x.exe");
    expect(exe.status).toBe(400);
    expect(exe.body.error.code).toBe("UNSUPPORTED_FILE");

    const spoof = await request(a).post("/api/generate").field("url", "acme.test").attach("sample", Buffer.from("hi"), "x.pdf");
    expect(spoof.body.error.code).toBe("INVALID_UPLOAD");

    const big = await request(a)
      .post("/api/generate")
      .field("url", "acme.test")
      .attach("sample", Buffer.alloc(5_000, 65), "big.txt");
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("FILE_TOO_LARGE");
  });

  it("surfaces LLM errors with a safe message", async () => {
    const res = await request(
      app(async () => {
        throw new AppError("LLM_RATE_LIMIT", "rate limited", 429);
      }),
    )
      .post("/api/generate")
      .field("url", "acme.test");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("LLM_RATE_LIMIT");
  });

  it("hides internal error details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      app(async () => {
        throw new Error("secret stack detail");
      }),
    )
      .post("/api/generate")
      .field("url", "acme.test");
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("rate-limits generation", async () => {
    const a = app(async () => sampleDraft(), { RATE_LIMIT_PER_MIN: "1" });
    expect((await request(a).post("/api/generate").field("url", "acme.test")).status).toBe(200);
    const res = await request(a).post("/api/generate").field("url", "acme.test");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("POST /api/export/docx", () => {
  it("returns a valid .docx containing the edited content", async () => {
    const doc = sampleDocument();
    doc.sections[0].clips[0].transcript = "Edited by the user [TO CONFIRM: owner name]";
    const res = await request(app())
      .post("/api/export/docx")
      .send(doc)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("wordprocessingml");
    expect(res.headers["content-disposition"]).toContain("Acme-Plomberie-voice-agent-script.docx");
    const zip = await JSZip.loadAsync(res.body as Buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Edited by the user");
    expect(xml).toContain("[TO CONFIRM: owner name]");
    expect(xml).toContain("INFORMATION TO CONFIRM");
    expect(xml).toContain('w:highlight w:val="yellow"');
    // Reference catalog layout: bilingual 4-column table, clip file names, routing labels, clip count.
    expect(xml).toContain("1. OPENING");
    expect(xml).toContain("French Transcript");
    expect(xml).toContain("English Title");
    expect(xml).toContain("opening_a.mp3");
    expect(xml).toContain("opening_a_en.mp3");
    expect(xml).toContain("Suite — ");
    expect(xml).toContain("Routing — ");
    expect(xml).toContain("Français / English · 9 clips");
    const header = await zip.file("word/header1.xml")!.async("string");
    expect(header).toContain("FR / EN");
  });

  it("renders a single-language catalog with two columns", async () => {
    const doc = { ...sampleDocument(), languageAlt: null };
    const res = await request(app())
      .post("/api/export/docx")
      .send(doc)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    const xml = await (await JSZip.loadAsync(res.body as Buffer)).file("word/document.xml")!.async("string");
    expect(xml).not.toContain("English Title");
    expect(xml).toContain(">Transcript<");
  });

  it("validates the document body", async () => {
    const res = await request(app()).post("/api/export/docx").send({ title: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INPUT");
  });

  it("rejects malformed JSON", async () => {
    const res = await request(app()).post("/api/export/docx").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});

describe("POST /api/claude-prompt", () => {
  it("rebuilds the prompt from an edited document", async () => {
    const doc = sampleDocument();
    doc.sections[0].clips[0].transcript = "Edited opening line";
    const res = await request(app()).post("/api/claude-prompt").send(doc);
    expect(res.status).toBe(200);
    expect(res.body.claudePrompt).toContain("## 1. OPENING");
    expect(res.body.claudePrompt).toContain('- opening_a: "Edited opening line"');
    expect(res.body.claudePrompt).toContain("Speak French");
    expect(res.body.claudePrompt).toContain("- Opening hours (Routing)");
  });
});

it("returns JSON 404 for unknown API routes", async () => {
  const res = await request(app()).get("/api/nope");
  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe("NOT_FOUND");
});
