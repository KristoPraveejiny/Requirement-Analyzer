import { useState, type FormEvent } from "react";
import { LANGUAGES, type GenerateInput, type Language, type Mode } from "../types";

const ALLOWED = [".docx", ".pdf", ".txt", ".md"];

interface Props {
  busy: boolean;
  maxUploadMb: number;
  onSubmit: (input: GenerateInput) => void;
}

export function GeneratorForm({ busy, maxUploadMb, onSubmit }: Props) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("voice-agent");
  const [language, setLanguage] = useState<Language | "auto">("auto");
  const [languageAlt, setLanguageAlt] = useState<Language | "none">("English");
  const [sample, setSample] = useState<File | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    onSubmit({ url: url.trim(), mode, language, languageAlt, sample });
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">
        <span>Client website URL</span>
        <input
          type="text"
          inputMode="url"
          placeholder="https://www.example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          disabled={busy}
          autoFocus
        />
      </label>

      <fieldset className="field" disabled={busy}>
        <legend>Document type</legend>
        <div className="segmented">
          {(["voice-agent", "voicemail"] as const).map((m) => (
            <label key={m} className={mode === m ? "active" : ""}>
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              {m === "voice-agent" ? "Voice agent" : "Voicemail"}
            </label>
          ))}
        </div>
      </fieldset>

      <LanguageSelects
        busy={busy}
        language={language}
        languageAlt={languageAlt}
        onLanguage={setLanguage}
        onLanguageAlt={setLanguageAlt}
      />
      <small className="hint">
        A French website with “Same as website” + English gives a French / English catalog. If both languages match,
        the script is single-language.
      </small>

      <SampleInput busy={busy} maxUploadMb={maxUploadMb} sample={sample} onChange={setSample} />

      <button className="primary" type="submit" disabled={busy || !url.trim()}>
        {busy ? "Generating…" : "Generate script"}
      </button>
    </form>
  );
}

interface LanguageProps {
  busy: boolean;
  language: Language | "auto";
  languageAlt: Language | "none";
  onLanguage: (l: Language | "auto") => void;
  onLanguageAlt: (l: Language | "none") => void;
}

export function LanguageSelects({ busy, language, languageAlt, onLanguage, onLanguageAlt }: LanguageProps) {
  return (
    <div className="field-row">
      <label className="field">
        <span>Script language</span>
        <select value={language} disabled={busy} onChange={(e) => onLanguage(e.target.value as Language | "auto")}>
          <option value="auto">Same as website</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Second language column</span>
        <select value={languageAlt} disabled={busy} onChange={(e) => onLanguageAlt(e.target.value as Language | "none")}>
          <option value="none">None (single language)</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

interface SampleProps {
  busy: boolean;
  maxUploadMb: number;
  sample: File | null;
  onChange: (file: File | null) => void;
}

/** Optional sample-document picker with client-side type/size checks (the server re-validates). */
export function SampleInput({ busy, maxUploadMb, sample, onChange }: SampleProps) {
  const [error, setError] = useState<string | null>(null);
  // Changing the key resets the native file input after "Remove".
  const [inputKey, setInputKey] = useState(0);

  function pick(file: File | null) {
    setError(null);
    if (!file) return onChange(null);
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (!ALLOWED.includes(ext)) {
      onChange(null);
      return setError(`Unsupported file type. Allowed: ${ALLOWED.join(", ")}`);
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      onChange(null);
      return setError(`File is larger than ${maxUploadMb} MB.`);
    }
    onChange(file);
  }

  return (
    <div className="field">
      <span>
        Sample document <em>(optional — used as a style reference, not a template)</em>
      </span>
      <input key={inputKey} type="file" accept={ALLOWED.join(",")} disabled={busy} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      {sample && (
        <small className="hint">
          Using <strong>{sample.name}</strong>{" "}
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              onChange(null);
              setInputKey((k) => k + 1);
            }}
          >
            Remove
          </button>
        </small>
      )}
      <small className="hint">
        {ALLOWED.join(", ")} · max {maxUploadMb} MB
      </small>
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}
