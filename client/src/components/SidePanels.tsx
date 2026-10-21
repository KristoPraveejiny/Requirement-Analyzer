import { useState } from "react";
import type { GenerateResponse, RequirementsDocument } from "../types";

export function MissingInfoPanel({ doc, placeholders }: { doc: RequirementsDocument; placeholders: number }) {
  return (
    <section className="card panel">
      <h3>
        Missing information <span className="badge warn">{doc.missingInformation.length}</span>
      </h3>
      <p className="hint">
        These details weren't found on the website. Confirm them with the client before go-live
        {placeholders > 0 && <> — {placeholders} [TO CONFIRM] placeholder(s) remain in the document</>}.
      </p>
      {doc.missingInformation.length ? (
        <ul className="missing">
          {doc.missingInformation.map((m, i) => (
            <li key={i}>
              <strong>{m.item || "(untitled)"}</strong>
              {m.whyNeeded && <span> — {m.whyNeeded}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p>None listed.</p>
      )}
    </section>
  );
}

export function SourcesPanel({ crawl, doc }: { crawl: GenerateResponse["crawl"]; doc: RequirementsDocument }) {
  return (
    <section className="card panel">
      <h3>Sources</h3>
      <ul className="sources">
        {crawl.pages.map((p) => (
          <li key={p.url}>
            <a href={p.url} target="_blank" rel="noopener noreferrer">
              {p.title || p.url}
            </a>
            {doc.sourcesUsed.includes(p.url) && <span className="badge">cited</span>}
          </li>
        ))}
      </ul>
      {crawl.skipped.length > 0 && (
        <details>
          <summary>{crawl.skipped.length} page(s) skipped</summary>
          <ul className="sources">
            {crawl.skipped.map((s) => (
              <li key={s.url}>
                {s.url} — <em>{s.reason}</em>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

interface PromptProps {
  prompt: string;
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onDownload: () => void;
}

export function ClaudePromptPanel({ prompt, stale, refreshing, onRefresh, onDownload }: PromptProps) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — user can select the text manually */
    }
  }
  return (
    <section className="card panel">
      <h3>Claude-ready prompt</h3>
      <p className="hint">Paste this as a system prompt in Claude to prototype the agent.</p>
      {stale && (
        <p className="notice">
          The document was edited.{" "}
          <button type="button" className="link" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Updating…" : "Update prompt"}
          </button>
        </p>
      )}
      <textarea className="prompt" readOnly value={prompt} rows={14} />
      <div className="row">
        <button type="button" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
        <button type="button" onClick={onDownload}>Download .md</button>
      </div>
    </section>
  );
}
