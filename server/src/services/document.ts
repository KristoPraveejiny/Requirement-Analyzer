import {
  LANGUAGES,
  SECTIONS,
  type Language,
  type LlmDraft,
  type Mode,
  type RequirementsDocument,
} from "../types.js";

export interface AssembleContext {
  mode: Mode;
  websiteUrl: string;
  crawledUrls: string[];
  language: Language | "auto";
  languageAlt: Language | null;
  now?: Date;
}

/** Normalises an LLM draft into the fixed, ordered catalog structure. */
export function assembleDocument(draft: LlmDraft, ctx: AssembleContext): RequirementsDocument {
  const host = new URL(ctx.websiteUrl).hostname.replace(/^www\./, "");
  const clientName = draft.clientName.trim().slice(0, 200) || host;
  const language = ctx.language === "auto" ? matchLanguage(draft.language) ?? "English" : ctx.language;
  const languageAlt = ctx.languageAlt && ctx.languageAlt !== language ? ctx.languageAlt : null;
  const bilingual = languageAlt !== null;
  const alt = (s: string, max: number) => (bilingual ? s.trim().slice(0, max) : "");

  const usedNames = new Set<string>();
  const usedAltNames = new Set<string>();
  const sections = SECTIONS[ctx.mode].map((def) => {
    const s = draft.sections[def.id];
    const clips = (s?.clips ?? [])
      .filter((c) => c.transcript.trim())
      .slice(0, 40)
      .map((c, i) => ({
        name: unique(slug(c.name) || `${def.id}_${i + 1}`, usedNames),
        nameAlt: bilingual ? unique(slug(c.nameAlt) || slug(c.name) || `${def.id}_${i + 1}`, usedAltNames) : "",
        transcript: c.transcript.trim().slice(0, 2000),
        transcriptAlt: alt(c.transcriptAlt, 2000),
        answer: c.answer.trim().slice(0, 300),
        answerAlt: alt(c.answerAlt, 300),
      }));
    return {
      id: def.id,
      title: def.title,
      intro: (s?.intro ?? "").trim().slice(0, 500),
      introAlt: alt(s?.introAlt ?? "", 500),
      clips: clips.length
        ? clips
        : [
            {
              name: unique(`${def.id}_1`, usedNames),
              nameAlt: bilingual ? unique(`${def.id}_1`, usedAltNames) : "",
              transcript: "[TO CONFIRM: No clips were generated for this section.]",
              transcriptAlt: bilingual ? "[TO CONFIRM: No clips were generated for this section.]" : "",
              answer: "",
              answerAlt: "",
            },
          ],
      routing: (s?.routing ?? [])
        .filter((r) => r.text.trim())
        .slice(0, 20)
        .map((r) => ({ text: r.text.trim().slice(0, 3000), textAlt: alt(r.textAlt, 3000) })),
    };
  });

  // Only keep sources we actually crawled; models sometimes cite URLs they weren't given.
  const crawled = new Set(ctx.crawledUrls.map(normaliseUrl));
  const sourcesUsed = draft.sourcesUsed.filter((u) => crawled.has(normaliseUrl(u)));

  return {
    title: (draft.title.trim() || `${clientName} ${ctx.mode === "voicemail" ? "Voicemail" : "Voice Agent"} Script`).slice(0, 300),
    mode: ctx.mode,
    clientName,
    websiteUrl: ctx.websiteUrl,
    generatedAt: (ctx.now ?? new Date()).toISOString(),
    language,
    languageAlt,
    routingLabel: (draft.routingLabel.trim() || (language === "French" ? "Suite" : "Routing")).slice(0, 40),
    contextLine: draft.contextLine.trim().slice(0, 1000),
    instructions: draft.instructions.trim().slice(0, 2000),
    instructionsAlt: alt(draft.instructionsAlt, 2000),
    sections,
    draftingBasis: draft.draftingBasis.trim().slice(0, 1500),
    draftingBasisAlt: alt(draft.draftingBasisAlt, 1500),
    missingInformation: draft.missingInformation
      .filter((m) => m.item.trim())
      .slice(0, 100)
      .map((m) => ({
        item: m.item.slice(0, 500),
        whyNeeded: m.whyNeeded.slice(0, 1000),
        section: m.section.slice(0, 100),
      })),
    assumptions: draft.assumptions.filter((a) => a.trim()).slice(0, 50).map((a) => a.slice(0, 1000)),
    sourcesUsed: (sourcesUsed.length ? sourcesUsed : ctx.crawledUrls).slice(0, 50),
  };
}

export function countClips(doc: RequirementsDocument): number {
  return doc.sections.reduce((n, s) => n + s.clips.length, 0);
}

function matchLanguage(name: string): Language | null {
  const n = name.trim().toLowerCase();
  for (const [key, meta] of Object.entries(LANGUAGES)) {
    if (n === key.toLowerCase() || n === meta.native.toLowerCase() || n === meta.code.toLowerCase()) {
      return key as Language;
    }
  }
  return null;
}

/** File-stem friendly name: lowercase snake_case, accents removed, no extension. */
function slug(name: string): string {
  return name
    .replace(/\.(mp3|wav)$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function unique(name: string, used: Set<string>): string {
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = `${name}_${i}`;
  used.add(candidate);
  return candidate;
}

function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().replace(/\/$/, "").replace(/^https?:\/\/www\./, "https://").replace(/^http:/, "https:");
  } catch {
    return u;
  }
}
