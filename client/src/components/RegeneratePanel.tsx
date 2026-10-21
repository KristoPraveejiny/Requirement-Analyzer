import { useState } from "react";
import type { GenerateInput, Language } from "../types";
import { LanguageSelects, SampleInput } from "./GeneratorForm";

interface Props {
  previous: GenerateInput;
  busy: boolean;
  dirty: boolean;
  maxUploadMb: number;
  onRegenerate: (input: GenerateInput) => void;
}

/** Re-runs generation for the same website with different languages and/or sample document. */
export function RegeneratePanel({ previous, busy, dirty, maxUploadMb, onRegenerate }: Props) {
  const [language, setLanguage] = useState<Language | "auto">(previous.language);
  const [languageAlt, setLanguageAlt] = useState<Language | "none">(previous.languageAlt);
  const [sample, setSample] = useState<File | null>(previous.sample);

  function submit() {
    if (dirty && !window.confirm("Regenerating replaces the current document, including your edits. Continue?")) return;
    onRegenerate({ ...previous, language, languageAlt, sample });
  }

  return (
    <section className="card panel regen">
      <h3>Language &amp; sample</h3>
      <p className="hint">Change the languages or reference sample, then regenerate the script for {previous.url}.</p>
      <LanguageSelects
        busy={busy}
        language={language}
        languageAlt={languageAlt}
        onLanguage={setLanguage}
        onLanguageAlt={setLanguageAlt}
      />
      <SampleInput busy={busy} maxUploadMb={maxUploadMb} sample={sample} onChange={setSample} />
      <button type="button" className="primary" onClick={submit} disabled={busy}>
        {busy ? "Regenerating…" : "Regenerate script"}
      </button>
      {busy && <p className="hint">This can take up to a couple of minutes.</p>}
    </section>
  );
}
