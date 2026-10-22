import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel, type Content, type GenerateContentParameters } from "@google/genai";
import { AppError } from "../errors.js";
import { buildUserMessage, MASTER_PROMPT } from "../prompts/master.js";
import { LlmDraftSchema, type DraftGenerator, type LlmDraft } from "../types.js";

/** Minimal subset of the SDK response used here (lets tests inject a fake client). */
export interface GeminiResponse {
  text?: string;
  candidates?: { finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export interface GeminiModels {
  generateContent(params: GenerateContentParameters): Promise<GeminiResponse>;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Defaults to the official @google/genai client. */
  models?: GeminiModels;
}

const TIMEOUT_MESSAGE = "The AI service took too long to respond. Please try again.";

/** Draft generator backed by the Gemini API. Retries once if the reply isn't valid JSON. */
export function createGeminiGenerator(options: GeminiOptions): DraftGenerator {
  const { apiKey, model, timeoutMs = 180_000, maxTokens = 16_000 } = options;
  // No httpOptions.retryOptions: the SDK then makes a single HTTP attempt. The only
  // retry is the JSON repair below, and it shares the same deadline.
  const models = options.models ?? new GoogleGenAI({ apiKey }).models;

  async function complete(contents: Content[], deadline: number): Promise<string> {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 1_000) throw new AppError("LLM_TIMEOUT", TIMEOUT_MESSAGE, 504);

    let res: GeminiResponse;
    try {
      res = await models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: MASTER_PROMPT,
          temperature: 0.2,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
          // Keeps latency down and stops thinking from eating the output budget.
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: AbortSignal.timeout(remainingMs),
        },
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new AppError("LLM_TIMEOUT", TIMEOUT_MESSAGE, 504);
      if (err instanceof ApiError || typeof (err as { status?: unknown })?.status === "number") {
        const status = (err as { status: number }).status;
        // Provider messages are logged server-side only; callers get a generic message.
        // The key travels in a request header and is never logged.
        console.error("Gemini error", { status, model, message: String((err as Error).message).slice(0, 500) });
        throw mapStatus(status);
      }
      console.error("Gemini request failed", { model, name });
      throw new AppError("LLM_FAILED", "Could not reach the AI service.", 502);
    }

    if (res.promptFeedback?.blockReason) {
      console.error("Gemini blocked prompt", { model, blockReason: res.promptFeedback.blockReason });
      throw new AppError("LLM_FORBIDDEN", "The AI service refused this request (blocked). Check the server logs.", 502);
    }
    const finishReason = res.candidates?.[0]?.finishReason;
    const content = res.text;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new AppError(
        "LLM_BAD_OUTPUT",
        content
          ? "The AI response was cut off. Try fewer pages or a shorter sample."
          : "The AI model used its whole output budget before writing the document. Try again or choose a different model.",
        502,
      );
    }
    if (!content) {
      if (finishReason) console.error("Gemini empty response", { model, finishReason });
      throw new AppError("LLM_BAD_OUTPUT", "The AI service returned an empty response.", 502);
    }
    return content;
  }

  return async (input) => {
    const contents: Content[] = [{ role: "user", parts: [{ text: buildUserMessage(input) }] }];
    // One deadline for the whole generation, so a JSON retry can't double the wait.
    const deadline = Math.min(Date.now() + timeoutMs, input.deadline ?? Infinity);
    const first = await complete(contents, deadline);
    try {
      return parseDraft(first);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid JSON";
      const retry = await complete([
        ...contents,
        { role: "model", parts: [{ text: first }] },
        {
          role: "user",
          parts: [{ text: `Your reply could not be used (${reason.slice(0, 300)}). Reply again with ONLY the corrected JSON object in the required shape.` }],
        },
      ], deadline);
      try {
        return parseDraft(retry);
      } catch {
        throw new AppError("LLM_BAD_OUTPUT", "The AI service returned a malformed document. Please try again.", 502);
      }
    }
  };
}

/** Extracts and validates the JSON object from a model reply. */
export function parseDraft(content: string): LlmDraft {
  const stripped = content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  const json = JSON.parse(stripped.slice(start, end + 1));
  const parsed = LlmDraftSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

function mapStatus(status: number): AppError {
  switch (status) {
    case 400:
      // Gemini returns 400 INVALID_ARGUMENT for a malformed/invalid API key, and
      // FAILED_PRECONDITION when the free tier isn't available in the caller's region.
      return new AppError("LLM_FAILED", "The AI service rejected the request (invalid API key, model, or region). Check the server logs.", 502);
    case 401:
      return new AppError("LLM_AUTH", "The AI service rejected the server's API key. Check the server configuration.", 502);
    case 403:
      return new AppError("LLM_FORBIDDEN", "The AI service refused this request (API key lacks permission, or blocked). Check the server logs.", 502);
    case 404:
      return new AppError("LLM_FAILED", "The configured AI model is not available for this API key. Check GEMINI_MODEL.", 502);
    case 429:
      return new AppError("LLM_RATE_LIMIT", "The AI service is rate-limiting requests (free-tier quota). Please wait and try again.", 429);
    case 503:
    case 504:
      return new AppError("LLM_FAILED", "The AI service is overloaded or timed out. Please try again shortly.", 502);
    default:
      return new AppError("LLM_FAILED", "The AI service failed to generate the document. Please try again.", 502);
  }
}
