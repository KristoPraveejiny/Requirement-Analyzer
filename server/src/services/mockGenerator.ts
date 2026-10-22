import { SECTIONS, type DraftGenerator, type LlmDraft } from "../types.js";

const TBC = (what: string) => `[TO CONFIRM: ${what}]`;
const YNO = "Answers: Yes / No / Other";

/**
 * Offline generator used when no GEMINI_API_KEY is set. Produces a clearly
 * labelled English skeleton from the crawled pages so the full UI/export flow can be tested.
 */
export const mockGenerator: DraftGenerator = async ({ mode, websiteUrl, pages, languageAlt }) => {
  const home = pages[0];
  const clientName =
    home?.title.split(/\s[|–—-]\s/)[0]?.trim() || new URL(websiteUrl).hostname.replace(/^www\./, "");
  const bi = (s: string) => (languageAlt ? `${s} (${languageAlt} translation)` : "");
  const clip = (name: string, transcript: string, answer = "") => ({
    name,
    nameAlt: name,
    transcript,
    transcriptAlt: bi(transcript),
    answer,
    answerAlt: answer ? bi(answer) : "",
  });

  const clipsBySection: Record<string, ReturnType<typeof clip>[]> = {
    opening: [clip("opening_1", `Hello, this is [FIRST_NAME] from [BRAND]. ${TBC("reason for the call")} Is now a good time?`, YNO)],
    greeting: [clip("greeting_1", `Thank you for calling ${clientName}. ${TBC("why the call is going to voicemail")} Please leave your name, number and a short message.`)],
    qualifying: [clip("q_name", "May I have your name, please?", "Open answer: full name."), clip("q_need", TBC("main qualifying question"), YNO)],
    capture: [clip("q_name", "Please say your name.", "Open answer: full name."), clip("q_number", "What number can we call you back on?", "Open answer: phone number.")],
    closing: [clip("closing_1", `Thank you, your request has been recorded. ${TBC("what happens next and when")}`)],
    resume: [clip("resume_name", "Could you repeat your name, please?", "Open answer: full name.")],
    flow_edge: [clip("who_is_calling", "I'm calling from [BRAND].")],
    edge: [clip("question_unknown", "I don't have that information, but someone from the team can follow up with you.")],
    urgent: [clip("after_hours", TBC("opening hours and after-hours message"))],
    exits: [clip("global_exit", "No problem. Thank you for your time. Goodbye."), clip("wrong_number", "Sorry for the disturbance. Goodbye.")],
    silence: [clip("still_there", "Are you still there?", YNO), clip("silence_exit", "I can't hear you anymore. I'll end the call now. Goodbye.")],
    extra: [clip("callback_time", "When would you prefer to be called back?", "Open answer: preferred day and time.")],
  };

  const draft: LlmDraft = {
    clientName,
    title: `${clientName} ${mode === "voicemail" ? "Voicemail" : "Voice Agent"} Script`,
    language: "English",
    routingLabel: "Routing",
    contextLine: `MOCK MODE — no AI model was called (GEMINI_API_KEY is not set) · [BRAND]: ${clientName} · [FIRST_NAME]: agent name`,
    instructions: "Not spoken: ask one question at a time. Do not read answer labels or routing notes.",
    instructionsAlt: bi("Not spoken: ask one question at a time."),
    sections: Object.fromEntries(
      SECTIONS[mode].map((s) => [
        s.id,
        {
          intro: s.purpose,
          introAlt: bi(s.purpose),
          clips: clipsBySection[s.id] ?? [],
          routing: [{ text: `${TBC("routing rules for this section")}`, textAlt: bi("routing rules") }],
        },
      ]),
    ),
    draftingBasis: `Built from ${pages.length} crawled page(s) of ${websiteUrl} in mock mode.`,
    draftingBasisAlt: bi("Mock mode."),
    missingInformation: [
      { item: "Purpose of the call and offer", whyNeeded: "Opening clips", section: "opening" },
      { item: "Opening hours", whyNeeded: "Out-of-hours handling", section: "exits" },
      { item: "Callback rules and timeframe", whyNeeded: "Closing clips", section: "closing" },
    ],
    assumptions: ["Mock output — replace by configuring GEMINI_API_KEY."],
    sourcesUsed: pages.map((p) => p.url),
  };
  return draft;
};
