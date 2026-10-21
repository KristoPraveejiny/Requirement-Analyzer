import { AppError } from "../errors.js";
import { buildUserMessage, MASTER_PROMPT } from "../prompts/master.js";
import { LlmDraftSchema, type DraftGenerator, type LlmDraft } from "../types.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** Draft generator backed by OpenRouter. Retries once if the reply isn't valid JSON. */
export function createOpenRouterGenerator(options: OpenRouterOptions): DraftGenerator {
  const { apiKey, model, timeoutMs = 180_000, maxTokens = 16_000, fetchImpl = fetch } = options;

  async function complete(messages: ChatMessage[]): Promise<string> {
    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Voice Agent Requirements Generator",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: maxTokens,
          // Reasoning models can otherwise spend the whole token budget thinking and
          // return no content. Ignored by models without reasoning support.
          reasoning: { effort: "low", exclude: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AppError("LLM_TIMEOUT", "The AI service took too long to respond. Please try again.", 504);
      }
      throw new AppError("LLM_FAILED", "Could not reach the AI service.", 502);
    }

    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      error?: { message?: string };
    } | null;

    if (!res.ok || body?.error) {
      // Provider messages are logged server-side only; callers get a generic message.
      console.error("OpenRouter error", res.status, body?.error?.message);
      throw mapStatus(res.status);
    }

    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    if (choice?.finish_reason === "length") {
      throw new AppError(
        "LLM_BAD_OUTPUT",
        content
          ? "The AI response was cut off. Try fewer pages or a shorter sample."
          : "The AI model used its whole output budget before writing the document. Try again or choose a different model.",
        502,
      );
    }
    if (!content) throw new AppError("LLM_BAD_OUTPUT", "The AI service returned an empty response.", 502);
    return content;
  }

  return async (input) => {
    const messages: ChatMessage[] = [
      { role: "system", content: MASTER_PROMPT },
      { role: "user", content: buildUserMessage(input) },
    ];
    const first = await complete(messages);
    try {
      return parseDraft(first);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "invalid JSON";
      const retry = await complete([
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `Your reply could not be used (${reason.slice(0, 300)}). Reply again with ONLY the corrected JSON object in the required shape.`,
        },
      ]);
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
    case 401:
    case 403:
      return new AppError("LLM_AUTH", "The AI service rejected the server's API key. Check the server configuration.", 502);
    case 402:
      return new AppError("LLM_CREDITS", "The AI service account has insufficient credits.", 502);
    case 429:
      return new AppError("LLM_RATE_LIMIT", "The AI service is rate-limiting requests. Please wait and try again.", 429);
    default:
      return new AppError("LLM_FAILED", "The AI service failed to generate the document. Please try again.", 502);
  }
}
