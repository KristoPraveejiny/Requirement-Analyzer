import type { CatalogSection, Clip, MissingItem, RequirementsDocument, Routing } from "../types";
import { Highlighted } from "./RichText";

interface Props {
  doc: RequirementsDocument;
  editing: boolean;
  onChange: (doc: RequirementsDocument) => void;
}

const NATIVE: Record<string, string> = {
  English: "English", French: "Français", Spanish: "Español", German: "Deutsch",
  Italian: "Italiano", Portuguese: "Português", Dutch: "Nederlands",
};

export function clipCount(doc: RequirementsDocument): number {
  return doc.sections.reduce((n, s) => n + s.clips.length, 0);
}

/** Preview (catalog layout, mirrors the DOCX) or edit view of the script catalog. */
export function DocumentView({ doc, editing, onChange }: Props) {
  return editing ? <Editor doc={doc} onChange={onChange} /> : <Preview doc={doc} />;
}

function Preview({ doc }: { doc: RequirementsDocument }) {
  const bi = doc.languageAlt !== null;
  const langs = bi ? `${NATIVE[doc.language]} / ${NATIVE[doc.languageAlt!]}` : NATIVE[doc.language];
  return (
    <article className="card doc catalog">
      <h2 className="cat-title">{doc.title}</h2>
      <p className="cat-subtitle">
        Audio Recordings Catalog · {doc.mode === "voicemail" ? "Voicemail" : "Voice agent"} · {langs} · {clipCount(doc)} clips
      </p>
      {doc.contextLine && <p className="cat-note"><Highlighted text={doc.contextLine} /></p>}
      {doc.instructions && <p className="cat-note"><Highlighted text={doc.instructions} /></p>}
      {doc.instructionsAlt && <p className="cat-note alt"><Highlighted text={doc.instructionsAlt} /></p>}

      {doc.sections.map((s, i) => (
        <section key={s.id}>
          <h3 className="cat-h">{i + 1}. {s.title}</h3>
          {(s.intro || s.introAlt) && (
            <p className="cat-intro"><Highlighted text={[s.intro, s.introAlt].filter(Boolean).join(" / ")} /></p>
          )}
          <div className="table-wrap">
            <table className={`clips ${bi ? "bi" : ""}`}>
              <thead>
                <tr>
                  {bi ? (
                    <>
                      <th>{doc.language} Title</th>
                      <th>{doc.languageAlt} Title</th>
                      <th>{doc.language} Transcript</th>
                      <th>{doc.languageAlt} Transcript</th>
                    </>
                  ) : (
                    <>
                      <th>Title</th>
                      <th>Transcript</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {s.clips.map((c, j) => (
                  <tr key={j}>
                    <td className="fname">{c.name}.mp3</td>
                    {bi && <td className="fname">{(c.nameAlt || c.name)}.mp3</td>}
                    <td>
                      <Highlighted text={c.transcript} />
                      {c.answer && <div className="answer"><Highlighted text={c.answer} /></div>}
                    </td>
                    {bi && (
                      <td>
                        <Highlighted text={c.transcriptAlt} />
                        {c.answerAlt && <div className="answer"><Highlighted text={c.answerAlt} /></div>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {s.routing.map((r, j) => (
            <div key={j} className="routing">
              <p><strong>{doc.routingLabel} — </strong><Highlighted text={r.text} /></p>
              {bi && r.textAlt && (
                <p className="alt"><strong>Routing — </strong><Highlighted text={r.textAlt} /></p>
              )}
            </div>
          ))}
        </section>
      ))}

      {doc.assumptions.length > 0 && (
        <section>
          <h3 className="cat-h">Assumptions to confirm</h3>
          <ul className="cat-list">{doc.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
      {(doc.draftingBasis || doc.draftingBasisAlt) && (
        <p className="cat-basis">
          Drafting basis, not spoken — {[doc.draftingBasis, doc.draftingBasisAlt].filter(Boolean).join(" / ")}
        </p>
      )}
    </article>
  );
}

function Editor({ doc, onChange }: { doc: RequirementsDocument; onChange: (doc: RequirementsDocument) => void }) {
  const bi = doc.languageAlt !== null;
  const set = <K extends keyof RequirementsDocument>(key: K, value: RequirementsDocument[K]) =>
    onChange({ ...doc, [key]: value });
  const setSection = (i: number, patch: Partial<CatalogSection>) =>
    set("sections", doc.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setClip = (si: number, ci: number, patch: Partial<Clip>) =>
    setSection(si, { clips: doc.sections[si].clips.map((c, j) => (j === ci ? { ...c, ...patch } : c)) });
  const setRouting = (si: number, ri: number, patch: Partial<Routing>) =>
    setSection(si, { routing: doc.sections[si].routing.map((r, j) => (j === ri ? { ...r, ...patch } : r)) });
  const setMissing = (i: number, patch: Partial<MissingItem>) =>
    set("missingInformation", doc.missingInformation.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const altLabel = doc.languageAlt ?? "";

  return (
    <article className="card doc editing">
      <label className="field">
        <span>Title</span>
        <input value={doc.title} maxLength={300} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label className="field">
        <span>Context line (not spoken: market, [TOKENS] and their meaning)</span>
        <AutoTextarea value={doc.contextLine} maxLength={1000} onChange={(v) => set("contextLine", v)} />
      </label>
      <label className="field">
        <span>Instructions — {doc.language} (not spoken)</span>
        <AutoTextarea value={doc.instructions} maxLength={2000} onChange={(v) => set("instructions", v)} />
      </label>
      {bi && (
        <label className="field">
          <span>Instructions — {altLabel}</span>
          <AutoTextarea value={doc.instructionsAlt} maxLength={2000} onChange={(v) => set("instructionsAlt", v)} />
        </label>
      )}

      {doc.sections.map((s, si) => (
        <fieldset key={s.id} className="section-edit">
          <legend>{si + 1}. {s.title}</legend>
          <div className={bi ? "pair" : ""}>
            <input value={s.intro} maxLength={500} placeholder={`Section note (${doc.language})`} onChange={(e) => setSection(si, { intro: e.target.value })} />
            {bi && <input value={s.introAlt} maxLength={500} placeholder={`Section note (${altLabel})`} onChange={(e) => setSection(si, { introAlt: e.target.value })} />}
          </div>

          {s.clips.map((c, ci) => (
            <div key={ci} className="clip-edit">
              <div className={bi ? "pair" : ""}>
                <div className="clip-col">
                  <input className="mono" value={c.name} maxLength={80} placeholder="file_name" aria-label="Clip name" onChange={(e) => setClip(si, ci, { name: e.target.value })} />
                  <AutoTextarea value={c.transcript} maxLength={2000} onChange={(v) => setClip(si, ci, { transcript: v })} />
                  <input value={c.answer} maxLength={300} placeholder="Expected answer note (optional)" onChange={(e) => setClip(si, ci, { answer: e.target.value })} />
                </div>
                {bi && (
                  <div className="clip-col">
                    <input className="mono" value={c.nameAlt} maxLength={80} placeholder="file_name" aria-label={`Clip name (${altLabel})`} onChange={(e) => setClip(si, ci, { nameAlt: e.target.value })} />
                    <AutoTextarea value={c.transcriptAlt} maxLength={2000} onChange={(v) => setClip(si, ci, { transcriptAlt: v })} />
                    <input value={c.answerAlt} maxLength={300} placeholder="Expected answer note (optional)" onChange={(e) => setClip(si, ci, { answerAlt: e.target.value })} />
                  </div>
                )}
              </div>
              <button type="button" className="ghost small" onClick={() => setSection(si, { clips: s.clips.filter((_, j) => j !== ci) })}>
                Remove clip
              </button>
            </div>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() =>
              setSection(si, {
                clips: [...s.clips, { name: `${s.id}_${s.clips.length + 1}`, nameAlt: bi ? `${s.id}_${s.clips.length + 1}` : "", transcript: "", transcriptAlt: "", answer: "", answerAlt: "" }],
              })
            }
          >
            + Add clip
          </button>

          <div className="routing-edit">
            <span className="label">{doc.routingLabel} / routing rules (not spoken)</span>
            {s.routing.map((r, ri) => (
              <div key={ri} className="routing-row">
                <div className={bi ? "pair" : ""}>
                  <AutoTextarea value={r.text} maxLength={3000} onChange={(v) => setRouting(si, ri, { text: v })} />
                  {bi && <AutoTextarea value={r.textAlt} maxLength={3000} onChange={(v) => setRouting(si, ri, { textAlt: v })} />}
                </div>
                <button type="button" className="ghost small" aria-label="Remove rule" onClick={() => setSection(si, { routing: s.routing.filter((_, j) => j !== ri) })}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="ghost" onClick={() => setSection(si, { routing: [...s.routing, { text: "", textAlt: "" }] })}>
              + Add rule
            </button>
          </div>
        </fieldset>
      ))}

      <div className="field">
        <span>Information to confirm</span>
        {doc.missingInformation.map((m, i) => (
          <div key={i} className="missing-row">
            <input value={m.item} placeholder="Item" maxLength={500} onChange={(e) => setMissing(i, { item: e.target.value })} />
            <input value={m.whyNeeded} placeholder="Why it's needed" maxLength={1000} onChange={(e) => setMissing(i, { whyNeeded: e.target.value })} />
            <button type="button" className="ghost" aria-label="Remove item" onClick={() => set("missingInformation", doc.missingInformation.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="ghost" onClick={() => set("missingInformation", [...doc.missingInformation, { item: "", whyNeeded: "", section: "" }])}>
          + Add missing item
        </button>
      </div>

      <label className="field">
        <span>Assumptions (one per line)</span>
        <AutoTextarea value={doc.assumptions.join("\n")} onChange={(v) => set("assumptions", v.split("\n").filter((a) => a.trim()).slice(0, 50))} />
      </label>
      <label className="field">
        <span>Drafting basis (not spoken)</span>
        <AutoTextarea value={doc.draftingBasis} maxLength={1500} onChange={(v) => set("draftingBasis", v)} />
      </label>
    </article>
  );
}

function AutoTextarea({ value, onChange, maxLength }: { value: string; onChange: (v: string) => void; maxLength?: number }) {
  return (
    <textarea
      value={value}
      maxLength={maxLength}
      rows={Math.min(12, Math.max(2, Math.ceil(value.length / 70) + value.split("\n").length - 1))}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
