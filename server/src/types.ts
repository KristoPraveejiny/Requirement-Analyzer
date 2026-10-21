import { z } from "zod";

export const MODES = ["voice-agent", "voicemail"] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

/** Supported script languages (English names); native names are used in the document subtitle. */
export const LANGUAGES = {
  English: { native: "English", code: "EN" },
  French: { native: "Français", code: "FR" },
  Spanish: { native: "Español", code: "ES" },
  German: { native: "Deutsch", code: "DE" },
  Italian: { native: "Italiano", code: "IT" },
  Portuguese: { native: "Português", code: "PT" },
  Dutch: { native: "Nederlands", code: "NL" },
} as const;
export type Language = keyof typeof LANGUAGES;
const LANGUAGE_NAMES = Object.keys(LANGUAGES) as [Language, ...Language[]];
export const LanguageSchema = z.enum(LANGUAGE_NAMES);
/** "auto" = use the website's language. */
export const PrimaryLanguageSchema = z.union([z.literal("auto"), LanguageSchema]);
/** "none" = single-language script. */
export const SecondaryLanguageSchema = z.union([z.literal("none"), LanguageSchema]);

/** Fixed catalog sections, in order, per mode (modelled on the reference audio-catalog format). */
export const SECTIONS: Record<Mode, { id: string; title: string; purpose: string }[]> = {
  "voice-agent": [
    { id: "opening", title: "OPENING", purpose: "Short hook, who is calling and why, then wait for the answer." },
    { id: "qualifying", title: "QUALIFYING QUESTIONS", purpose: "Main flow: the questions that qualify the caller, one at a time, open questions for factual data." },
    { id: "closing", title: "TRANSFER / CLOSING", purpose: "Confirm the callback/transfer request and close. Confirm only what the business actually offers." },
    { id: "resume", title: "RESUME QUESTIONS", purpose: "Shorter re-asks for each main question left unanswered." },
    { id: "flow_edge", title: "FLOW EDGE QUESTIONS", purpose: "Interruptions during the opening: who is calling, why, which offer, no time, wants to speak now." },
    { id: "edge", title: "EDGE QUESTIONS", purpose: "Objections and caller questions grounded in the website; answer, then resume the flow." },
    { id: "exits", title: "GLOBAL EXITS", purpose: "Polite endings for each disqualification/refusal path, without persuasion loops." },
    { id: "silence", title: "SILENCE PROMPTS", purpose: "Still there? / repeat / end on silence." },
    { id: "extra", title: "EXTRA QUESTIONS", purpose: "Practical details only when needed: preferred callback time, other number, confirmations." },
  ],
  voicemail: [
    { id: "greeting", title: "VOICEMAIL GREETING", purpose: "Recorded greeting: business name, why the call wasn't answered, what to leave." },
    { id: "capture", title: "MESSAGE CAPTURE", purpose: "Prompts that collect name, callback number and reason for the call." },
    { id: "closing", title: "CONFIRMATION / CLOSING", purpose: "Confirm the message was recorded and what happens next, without inventing timeframes." },
    { id: "resume", title: "RESUME QUESTIONS", purpose: "Re-asks for details that were missing or unclear." },
    { id: "edge", title: "CALLER QUESTIONS", purpose: "Short answers to common questions grounded in the website, then return to capture." },
    { id: "urgent", title: "AFTER-HOURS / URGENT", purpose: "Out-of-hours and urgent-call messages; routing only if the website states it." },
    { id: "exits", title: "GLOBAL EXITS", purpose: "Wrong number, do-not-call, caller hangs up." },
    { id: "silence", title: "SILENCE PROMPTS", purpose: "Still there? / repeat / end on silence." },
  ],
};

const text = (max: number) => z.string().max(max);

export const MissingItemSchema = z.object({
  item: text(500),
  whyNeeded: text(1000).default(""),
  section: text(100).default(""),
});
export type MissingItem = z.infer<typeof MissingItemSchema>;

/** One recorded audio clip. Names are file stems (".mp3" is added when rendering). */
export const ClipSchema = z.object({
  name: text(80),
  nameAlt: text(80).default(""),
  transcript: text(2000),
  transcriptAlt: text(2000).default(""),
  /** Expected-answer note under the transcript, e.g. "Answers: Yes / No / Other". Not spoken. */
  answer: text(300).default(""),
  answerAlt: text(300).default(""),
});
export type Clip = z.infer<typeof ClipSchema>;

export const RoutingSchema = z.object({ text: text(3000), textAlt: text(3000).default("") });

export const SectionSchema = z.object({
  id: text(40),
  title: text(120),
  intro: text(500).default(""),
  introAlt: text(500).default(""),
  clips: z.array(ClipSchema).max(40),
  routing: z.array(RoutingSchema).max(20),
});
export type CatalogSection = z.infer<typeof SectionSchema>;

/** The editable script catalog exchanged with the client. */
export const DocumentSchema = z.object({
  title: text(300),
  mode: ModeSchema,
  clientName: text(200),
  websiteUrl: text(2048),
  generatedAt: text(64),
  language: LanguageSchema,
  /** null = single-language script. */
  languageAlt: LanguageSchema.nullable(),
  /** Label before primary-language routing notes, e.g. "Suite" in French. */
  routingLabel: text(40).default("Routing"),
  /** Unspoken context line: market, placeholder tokens and what they stand for. */
  contextLine: text(1000).default(""),
  instructions: text(2000).default(""),
  instructionsAlt: text(2000).default(""),
  sections: z.array(SectionSchema).max(12),
  draftingBasis: text(1500).default(""),
  draftingBasisAlt: text(1500).default(""),
  missingInformation: z.array(MissingItemSchema).max(100),
  assumptions: z.array(text(1000)).max(50),
  sourcesUsed: z.array(text(2048)).max(50),
});
export type RequirementsDocument = z.infer<typeof DocumentSchema>;

// --- LLM output (validated leniently, then normalised) ---

const loose = z.string().default("");
const LlmClipSchema = z.object({
  name: loose,
  nameAlt: loose,
  transcript: loose,
  transcriptAlt: loose,
  answer: loose,
  answerAlt: loose,
});
const LlmRoutingSchema = z.union([
  z.string().transform((t) => ({ text: t, textAlt: "" })),
  z.object({ text: loose, textAlt: loose }),
]);

export const LlmDraftSchema = z.object({
  clientName: loose,
  title: loose,
  language: loose,
  routingLabel: loose,
  contextLine: loose,
  instructions: loose,
  instructionsAlt: loose,
  sections: z
    .record(
      z.string(),
      z.object({
        intro: loose,
        introAlt: loose,
        clips: z.array(LlmClipSchema).default([]),
        routing: z.array(LlmRoutingSchema).default([]),
      }),
    )
    .default({}),
  draftingBasis: loose,
  draftingBasisAlt: loose,
  missingInformation: z
    .array(
      z.union([
        z.string().transform((item) => ({ item, whyNeeded: "", section: "" })),
        z.object({ item: z.string(), whyNeeded: loose, section: loose }),
      ]),
    )
    .default([]),
  assumptions: z.array(z.string()).default([]),
  sourcesUsed: z.array(z.string()).default([]),
});
export type LlmDraft = z.infer<typeof LlmDraftSchema>;

export interface SourcePage {
  url: string;
  title: string;
  text: string;
}

export interface GenerationInput {
  mode: Mode;
  websiteUrl: string;
  pages: SourcePage[];
  sample?: string;
  /** "auto" lets the model use the website's language. */
  language: Language | "auto";
  /** null = single-language script. */
  languageAlt: Language | null;
}

/** Produces a draft from website content; implemented by OpenRouter or the mock. */
export type DraftGenerator = (input: GenerationInput) => Promise<LlmDraft>;
