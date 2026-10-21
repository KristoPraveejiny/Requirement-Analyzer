import { loadConfig } from "../src/config.js";
import { SECTIONS, type LlmDraft, type RequirementsDocument } from "../src/types.js";

export const testConfig = (env: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: "test", RATE_LIMIT_PER_MIN: "100", ...env });

const clip = (name: string, transcript: string, answer = "") => ({
  name,
  nameAlt: `${name}_en`,
  transcript,
  transcriptAlt: `EN: ${transcript}`,
  answer,
  answerAlt: answer ? `EN: ${answer}` : "",
});

export const sampleDraft = (overrides: Partial<LlmDraft> = {}): LlmDraft => ({
  clientName: "Acme Plomberie",
  title: "Acme Plomberie Script",
  language: "French",
  routingLabel: "Suite",
  contextLine: "France · [MARQUE] : Acme",
  instructions: "Une question à la fois.",
  instructionsAlt: "One question at a time.",
  sections: Object.fromEntries(
    SECTIONS["voice-agent"].map((s) => [
      s.id,
      {
        intro: `Intro ${s.id}`,
        introAlt: `Intro EN ${s.id}`,
        clips: [clip(`${s.id}_a`, `Bonjour ${s.id} [TO CONFIRM: horaires]`, "Réponses : Oui / Non / Autre")],
        routing: [{ text: `${s.id}_a : Oui → suite`, textAlt: `${s.id}_a_en: Yes → next` }],
      },
    ]),
  ),
  draftingBasis: "Site web",
  draftingBasisAlt: "Website",
  missingInformation: [{ item: "Opening hours", whyNeeded: "Routing", section: "exits" }],
  assumptions: ["Calls may be recorded"],
  sourcesUsed: ["https://acme.test/", "https://invented.test/page"],
  ...overrides,
});

export const sampleDocument = (): RequirementsDocument => ({
  title: "Acme Plomberie Script",
  mode: "voice-agent",
  clientName: "Acme Plomberie",
  websiteUrl: "https://acme.test/",
  generatedAt: "2026-10-21T00:00:00.000Z",
  language: "French",
  languageAlt: "English",
  routingLabel: "Suite",
  contextLine: "France · [MARQUE] : Acme",
  instructions: "Une question à la fois.",
  instructionsAlt: "One question at a time.",
  sections: SECTIONS["voice-agent"].map((s) => ({
    id: s.id,
    title: s.title,
    intro: `Intro ${s.id}`,
    introAlt: `Intro EN ${s.id}`,
    clips: [clip(`${s.id}_a`, `Bonjour [TO CONFIRM: détail]`, "Réponses : Oui / Non / Autre")],
    routing: [{ text: `${s.id}_a : Oui → suite`, textAlt: `${s.id}_a_en: Yes → next` }],
  })),
  draftingBasis: "Site web",
  draftingBasisAlt: "Website",
  missingInformation: [{ item: "Opening hours", whyNeeded: "Routing", section: "exits" }],
  assumptions: ["Calls may be recorded"],
  sourcesUsed: ["https://acme.test/"],
});
