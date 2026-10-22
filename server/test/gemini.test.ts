import { ApiError, type GenerateContentParameters } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { MASTER_PROMPT } from "../src/prompts/master.js";
import { createGeminiGenerator, type GeminiResponse } from "../src/services/gemini.js";
import type { GenerationInput } from "../src/types.js";

const input: GenerationInput = {
  mode: "voice-agent",
  websiteUrl: "https://acme.test/",
  pages: [{ url: "https://acme.test/", title: "Acme", text: "We fix leaks." }],
  language: "auto",
  languageAlt: "English",
};

const reply = (text: string, finishReason = "STOP"): GeminiResponse => ({ text, candidates: [{ finishReason }] });

function fakeModels(...replies: (GeminiResponse | Error)[]) {
  const generateContent = vi.fn(async (_params: GenerateContentParameters) => {
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return r;
  });
  return { generateContent };
}

describe("createGeminiGenerator", () => {
  it("sends the master prompt as the system instruction and parses the reply", async () => {
    const models = fakeModels(reply(JSON.stringify({ clientName: "Acme" })));
    const gen = createGeminiGenerator({ apiKey: "k", model: "gemini-test", models });
    expect((await gen(input)).clientName).toBe("Acme");

    const params = models.generateContent.mock.calls[0][0] as any;
    expect(params.model).toBe("gemini-test");
    expect(params.config.systemInstruction).toBe(MASTER_PROMPT);
    expect(params.config.responseMimeType).toBe("application/json");
    expect(params.config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(params.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(params.contents[0].role).toBe("user");
  });

  it("retries once on malformed JSON, replaying the model turn", async () => {
    const models = fakeModels(reply("not json"), reply('{"clientName":"Fixed"}'));
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models });
    expect((await gen(input)).clientName).toBe("Fixed");
    expect(models.generateContent).toHaveBeenCalledTimes(2);
    const retry = models.generateContent.mock.calls[1][0] as any;
    expect(retry.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("fails cleanly after a second malformed reply", async () => {
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models: fakeModels(reply("x"), reply("y")) });
    await expect(gen(input)).rejects.toMatchObject({ code: "LLM_BAD_OUTPUT" });
  });

  it.each([
    [400, "LLM_FAILED"],
    [401, "LLM_AUTH"],
    [403, "LLM_FORBIDDEN"],
    [404, "LLM_FAILED"],
    [429, "LLM_RATE_LIMIT"],
    [500, "LLM_FAILED"],
    [503, "LLM_FAILED"],
  ])("maps HTTP %i to %s without retrying", async (status, code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const models = fakeModels(new ApiError({ status, message: '{"error":{"message":"provider detail"}}' }));
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models });
    await expect(gen(input)).rejects.toMatchObject({ code });
    expect(models.generateContent).toHaveBeenCalledTimes(1);
  });

  it("logs status and provider message but never the API key, and keeps it out of the client message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const gen = createGeminiGenerator({
      apiKey: "AIza-secret-value",
      model: "m",
      models: fakeModels(new ApiError({ status: 400, message: '{"error":{"message":"API key not valid."}}' })),
    });
    const err = await gen(input).catch((e) => e);
    expect(err.code).toBe("LLM_FAILED");
    expect(err.message).not.toContain("API key not valid");
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("API key not valid.");
    expect(logged).toContain("400");
    expect(logged).not.toContain("AIza-secret-value");
  });

  it("maps network failures to LLM_FAILED", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models: fakeModels(new TypeError("fetch failed")) });
    await expect(gen(input)).rejects.toMatchObject({ code: "LLM_FAILED", status: 502 });
  });

  it("maps an aborted AI request to LLM_TIMEOUT (HTTP 504)", async () => {
    const gen = createGeminiGenerator({
      apiKey: "k",
      model: "m",
      timeoutMs: 5_000,
      models: fakeModels(new DOMException("timed out", "TimeoutError")),
    });
    await expect(gen(input)).rejects.toMatchObject({ code: "LLM_TIMEOUT", status: 504 });
  });

  it("aborts a slow upstream call at the deadline", async () => {
    const models = {
      generateContent: vi.fn(
        (params: any) =>
          new Promise<GeminiResponse>((_, reject) => {
            params.config.abortSignal.addEventListener("abort", () => reject(params.config.abortSignal.reason));
          }),
      ),
    };
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", timeoutMs: 5_000, models });
    const started = Date.now();
    await expect(gen({ ...input, deadline: Date.now() + 1_500 })).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("fails fast without calling the model when the request deadline is already spent", async () => {
    const models = fakeModels(reply("{}"));
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", timeoutMs: 60_000, models });
    await expect(gen({ ...input, deadline: Date.now() + 500 })).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
    expect(models.generateContent).not.toHaveBeenCalled();
  });

  it("shares one deadline between the first call and the JSON retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const generateContent = vi.fn(async () => {
        vi.setSystemTime(Date.now() + 9_500); // the first reply uses up most of the budget
        return reply("not json");
      });
      const gen = createGeminiGenerator({ apiKey: "k", model: "m", timeoutMs: 10_000, models: { generateContent } });
      await expect(gen(input)).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
      expect(generateContent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports truncated output", async () => {
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models: fakeModels(reply("{", "MAX_TOKENS")) });
    await expect(gen(input)).rejects.toMatchObject({ code: "LLM_BAD_OUTPUT", message: expect.stringContaining("cut off") });
  });

  it("explains when thinking exhausts the budget without content", async () => {
    const gen = createGeminiGenerator({ apiKey: "k", model: "m", models: fakeModels(reply("", "MAX_TOKENS")) });
    await expect(gen(input)).rejects.toMatchObject({ message: expect.stringContaining("output budget") });
  });

  it("maps a blocked prompt and an empty reply", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const blocked = createGeminiGenerator({
      apiKey: "k",
      model: "m",
      models: fakeModels({ promptFeedback: { blockReason: "SAFETY" } }),
    });
    await expect(blocked(input)).rejects.toMatchObject({ code: "LLM_FORBIDDEN" });
    const empty = createGeminiGenerator({ apiKey: "k", model: "m", models: fakeModels(reply("", "SAFETY")) });
    await expect(empty(input)).rejects.toMatchObject({ code: "LLM_BAD_OUTPUT" });
  });
});
