// Mirrors server/src/types.ts (DocumentSchema) — keep in sync.
export type Mode = "voice-agent" | "voicemail";

export const LANGUAGES = ["English", "French", "Spanish", "German", "Italian", "Portuguese", "Dutch"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Clip {
  name: string;
  nameAlt: string;
  transcript: string;
  transcriptAlt: string;
  answer: string;
  answerAlt: string;
}

export interface Routing {
  text: string;
  textAlt: string;
}

export interface CatalogSection {
  id: string;
  title: string;
  intro: string;
  introAlt: string;
  clips: Clip[];
  routing: Routing[];
}

export interface MissingItem {
  item: string;
  whyNeeded: string;
  section: string;
}

export interface RequirementsDocument {
  title: string;
  mode: Mode;
  clientName: string;
  websiteUrl: string;
  generatedAt: string;
  language: Language;
  languageAlt: Language | null;
  routingLabel: string;
  contextLine: string;
  instructions: string;
  instructionsAlt: string;
  sections: CatalogSection[];
  draftingBasis: string;
  draftingBasisAlt: string;
  missingInformation: MissingItem[];
  assumptions: string[];
  sourcesUsed: string[];
}

export interface GenerateInput {
  url: string;
  mode: Mode;
  language: Language | "auto";
  languageAlt: Language | "none";
  sample: File | null;
}

export interface GenerateResponse {
  document: RequirementsDocument;
  claudePrompt: string;
  crawl: { pages: { url: string; title: string }[]; skipped: { url: string; reason: string }[] };
  sampleUsed: boolean;
  mock: boolean;
}

export interface Health {
  status: string;
  mock: boolean;
  maxUploadMb: number;
}
