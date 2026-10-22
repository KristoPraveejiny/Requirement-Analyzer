import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, exportDocx, fileSlug, generate, getHealth, refreshClaudePrompt, saveBlob } from "./api";
import { DocumentView } from "./components/DocumentView";
import { GeneratorForm } from "./components/GeneratorForm";
import { RegeneratePanel } from "./components/RegeneratePanel";
import { countPlaceholders } from "./components/RichText";
import { ClaudePromptPanel, MissingInfoPanel, SourcesPanel } from "./components/SidePanels";
import type { GenerateInput, GenerateResponse, Health, RequirementsDocument } from "./types";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [doc, setDoc] = useState<RequirementsDocument | null>(null);
  const [prompt, setPrompt] = useState("");
  const [promptStale, setPromptStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastInput, setLastInput] = useState<GenerateInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setError("Could not reach the server. Is it running?"));
  }, []);

  const placeholders = useMemo(
    () => (doc ? countPlaceholders(JSON.stringify(doc)) : 0),
    [doc],
  );

  async function onGenerate(input: GenerateInput) {
    setBusy(true);
    setError(null);
    abortRef.current = new AbortController();
    try {
      const res = await generate(input, abortRef.current.signal);
      setResult(res);
      setDoc(res.document);
      setLastInput(input);
      setDirty(false);
      setPrompt(res.claudePrompt);
      setPromptStale(false);
      setEditing(false);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(errorMessage(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function onEdit(next: RequirementsDocument) {
    setDoc(next);
    setPromptStale(true);
    setDirty(true);
  }

  async function onRefreshPrompt() {
    if (!doc) return;
    setRefreshing(true);
    try {
      setPrompt(await refreshClaudePrompt(doc));
      setPromptStale(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function onDownloadDocx() {
    if (!doc) return;
    setExporting(true);
    try {
      saveBlob(await exportDocx(doc), `${fileSlug(doc)}-${doc.mode}-script.docx`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  function onDownloadPrompt() {
    if (!doc) return;
    saveBlob(new Blob([prompt], { type: "text/markdown" }), `${fileSlug(doc)}-claude-prompt.md`);
  }

  function reset() {
    setResult(null);
    setDoc(null);
    setPrompt("");
    setError(null);
  }

  return (
    <div className="app">
      <header className="top">
        <h1>Voice Agent Requirements Generator</h1>
        <p>Enter a client's website to draft a voice-agent or voicemail script catalog grounded in what the site actually says.</p>
      </header>

      {health?.mock && (
        <div className="banner warn">
          <strong>Mock mode:</strong> no Gemini API key is configured on the server, so documents are placeholder
          skeletons. Set <code>GEMINI_API_KEY</code> in <code>.env</code> and restart the server.
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
          <button type="button" className="ghost" onClick={() => setError(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {!doc ? (
        <main className="narrow">
          <GeneratorForm busy={busy} maxUploadMb={health?.maxUploadMb ?? 5} onSubmit={onGenerate} />
          {busy && (
            <div className="card loading" aria-live="polite">
              <div className="spinner" />
              <p>Reading the website and drafting requirements… this can take up to a minute.</p>
              <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
          )}
        </main>
      ) : (
        <main className="result">
          <div className="toolbar">
            <button type="button" onClick={reset}>← New document</button>
            <div className="segmented small">
              <label className={!editing ? "active" : ""}>
                <input type="radio" checked={!editing} onChange={() => setEditing(false)} /> Preview
              </label>
              <label className={editing ? "active" : ""}>
                <input type="radio" checked={editing} onChange={() => setEditing(true)} /> Edit
              </label>
            </div>
            <button type="button" className="primary" onClick={onDownloadDocx} disabled={exporting}>
              {exporting ? "Preparing…" : "Download DOCX"}
            </button>
          </div>
          {busy && (
            <div className="card loading" aria-live="polite">
              <div className="spinner" />
              <p>Regenerating the script with your new settings… the current document stays until it's ready.</p>
              <button type="button" className="ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
          )}
          <div className="columns">
            <DocumentView doc={doc} editing={editing} onChange={onEdit} />
            <aside>
              {lastInput && (
                <RegeneratePanel
                  key={result?.document.generatedAt}
                  previous={lastInput}
                  busy={busy}
                  dirty={dirty}
                  maxUploadMb={health?.maxUploadMb ?? 5}
                  onRegenerate={onGenerate}
                />
              )}
              <MissingInfoPanel doc={doc} placeholders={placeholders} />
              <ClaudePromptPanel
                prompt={prompt}
                stale={promptStale}
                refreshing={refreshing}
                onRefresh={onRefreshPrompt}
                onDownload={onDownloadPrompt}
              />
              {result && <SourcesPanel crawl={result.crawl} doc={doc} />}
            </aside>
          </div>
        </main>
      )}
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}
