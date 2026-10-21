import type { GenerateInput, GenerateResponse, Health, RequirementsDocument } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code = "UNKNOWN",
  ) {
    super(message);
  }
}

async function check(res: Response): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  throw new ApiError(body?.error?.message ?? `Request failed (HTTP ${res.status}).`, body?.error?.code);
}

async function call(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await check(await fetch(input, init));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Could not reach the server. Is it running?", "NETWORK");
  }
}

export async function getHealth(): Promise<Health> {
  return (await call("/api/health")).json();
}

export async function generate(input: GenerateInput, signal?: AbortSignal): Promise<GenerateResponse> {
  const form = new FormData();
  form.set("url", input.url);
  form.set("mode", input.mode);
  form.set("language", input.language);
  form.set("languageAlt", input.languageAlt);
  if (input.sample) form.set("sample", input.sample);
  return (await call("/api/generate", { method: "POST", body: form, signal })).json();
}

const jsonPost = (doc: RequirementsDocument): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(doc),
});

export async function exportDocx(doc: RequirementsDocument): Promise<Blob> {
  return (await call("/api/export/docx", jsonPost(doc))).blob();
}

export async function refreshClaudePrompt(doc: RequirementsDocument): Promise<string> {
  const body = (await (await call("/api/claude-prompt", jsonPost(doc))).json()) as { claudePrompt: string };
  return body.claudePrompt;
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileSlug(doc: RequirementsDocument): string {
  return (doc.clientName.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "client").slice(0, 60);
}
