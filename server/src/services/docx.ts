import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type IRunOptions,
} from "docx";
import { LANGUAGES, type Clip, type RequirementsDocument } from "../types.js";
import { countClips } from "./document.js";

// Palette and sizes (half-points) taken from the reference audio-catalog document.
const NAVY = "254F78";
const MUTED = "516171";
const INK = "172B3A";
const GRID = "CFD8E1";
const TABLE_WIDTH = 10262; // dxa
const PLACEHOLDER = /(\[TO CONFIRM:[^\]]*\])/g;

/** Renders the script catalog as a .docx in the reference layout. */
export async function renderDocx(doc: RequirementsDocument): Promise<Buffer> {
  const lang = LANGUAGES[doc.language];
  const alt = doc.languageAlt ? LANGUAGES[doc.languageAlt] : null;
  const modeLabel = doc.mode === "voicemail" ? "Voicemail" : "Voice agent";
  const langLabel = alt ? `${lang.native} / ${alt.native}` : lang.native;
  const codes = alt ? `${lang.code} / ${alt.code}` : lang.code;

  const children: (Paragraph | Table)[] = [
    new Paragraph({ children: [run(doc.title, { bold: true, color: NAVY, size: 38 })] }),
    new Paragraph({
      spacing: { after: 100 },
      children: [
        run(`Audio Recordings Catalog · ${modeLabel} · ${langLabel} · ${countClips(doc)} clips`, {
          italics: true,
          color: MUTED,
          size: 21,
        }),
      ],
    }),
  ];
  if (doc.contextLine) children.push(note(doc.contextLine, 17));
  if (doc.instructions) children.push(note(doc.instructions, 17, { after: 40 }));
  if (doc.instructionsAlt) children.push(note(doc.instructionsAlt, 16, { after: 80 }, true));

  doc.sections.forEach((section, i) => {
    children.push(new Paragraph({ text: `${i + 1}. ${section.title}`, heading: HeadingLevel.HEADING_1 }));
    const intro = [section.intro, section.introAlt].filter(Boolean).join(" / ");
    if (intro) {
      children.push(
        new Paragraph({
          keepNext: true,
          spacing: { after: 80 },
          children: runs(intro, { italics: true, color: MUTED, size: 17 }),
        }),
      );
    }
    children.push(clipTable(section.clips, doc));
    for (const r of section.routing) {
      children.push(
        new Paragraph({
          spacing: { before: 60, after: 20 },
          children: [
            run(`${doc.routingLabel} — `, { bold: true, color: MUTED, size: 16 }),
            ...runs(r.text, { color: MUTED, size: 16 }),
          ],
        }),
      );
      if (alt && r.textAlt) {
        children.push(
          new Paragraph({
            children: [
              run("Routing — ", { bold: true, color: MUTED, size: 16 }),
              ...runs(r.textAlt, { italics: true, color: MUTED, size: 16 }),
            ],
          }),
        );
      }
    }
  });

  children.push(new Paragraph({ text: `${doc.sections.length + 1}. INFORMATION TO CONFIRM`, heading: HeadingLevel.HEADING_1 }));
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      children: [run("Not found on the website — confirm with the client before recording.", { italics: true, color: MUTED, size: 17 })],
    }),
  );
  children.push(
    doc.missingInformation.length
      ? gridTable(
          [2600, 5262, 2400],
          ["Item", "Why it's needed", "Section"],
          doc.missingInformation.map((m) => [m.item, m.whyNeeded, m.section]),
        )
      : note("None identified.", 17),
  );
  if (doc.assumptions.length) {
    children.push(new Paragraph({ spacing: { before: 120 }, children: [run("Assumptions to confirm", { bold: true, color: MUTED, size: 17 })] }));
    children.push(...doc.assumptions.map((a) => new Paragraph({ bullet: { level: 0 }, children: runs(a, { color: MUTED, size: 17 }) })));
  }

  const basis = [doc.draftingBasis, doc.draftingBasisAlt].filter(Boolean).join(" / ");
  const sources = doc.sourcesUsed.length ? ` Sources: ${doc.sourcesUsed.join(" · ")}` : "";
  children.push(
    new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [run(`Drafting basis, not spoken — ${basis}${sources}`, { color: MUTED, size: 15 })],
    }),
  );

  const document = new Document({
    title: doc.title,
    creator: "Voice Agent Requirements Generator",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 19 }, paragraph: { spacing: { after: 60 } } },
        heading1: {
          run: { font: "Calibri", bold: true, color: NAVY, size: 24 },
          paragraph: { keepNext: true, keepLines: true, spacing: { before: 180, after: 80 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 765, right: 822, bottom: 709, left: 822, header: 312, footer: 312 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [run(`${doc.clientName.toUpperCase()}  |  ${modeLabel.toUpperCase()}  |  ${codes}`, { color: MUTED, size: 16 })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ children: [`${modeLabel} · `, PageNumber.CURRENT], color: MUTED, size: 16 })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

function run(text: string, opts: IRunOptions = {}) {
  return new TextRun({ ...opts, text });
}

/** Text runs with [TO CONFIRM: …] placeholders highlighted. */
function runs(text: string, opts: IRunOptions = {}): TextRun[] {
  return text
    .split(PLACEHOLDER)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("[TO CONFIRM:") && part.endsWith("]")
        ? new TextRun({ ...opts, text: part, bold: true, highlight: "yellow" })
        : new TextRun({ ...opts, text: part }),
    );
}

function note(text: string, size: number, spacing: { after?: number } = {}, italics = false) {
  return new Paragraph({ spacing, children: runs(text, { color: MUTED, size, italics }) });
}

const border = { style: BorderStyle.SINGLE, size: 4, color: GRID };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };

function headerCell(text: string, width: number) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: NAVY, color: "auto" },
    margins: { top: 65, bottom: 65 },
    children: [new Paragraph({ keepNext: true, spacing: { after: 0 }, children: [run(text, { bold: true, color: "FFFFFF", size: 18 })] })],
  });
}

function bodyCell(width: number, paragraphs: Paragraph[]) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    margins: { top: 55, bottom: 55 },
    verticalAlign: VerticalAlign.CENTER,
    children: paragraphs,
  });
}

function nameCell(name: string, width: number) {
  return bodyCell(width, [new Paragraph({ spacing: { after: 0 }, children: [run(`${name}.mp3`, { color: MUTED, size: 17 })] })]);
}

function transcriptCell(transcript: string, answer: string, width: number) {
  const paras = [new Paragraph({ spacing: { after: 0 }, children: runs(transcript, { color: INK }) })];
  if (answer) {
    paras.push(new Paragraph({ spacing: { before: 40, after: 0 }, children: runs(answer, { italics: true, color: MUTED, size: 16 }) }));
  }
  return bodyCell(width, paras);
}

function table(widths: number[], rows: TableRow[]) {
  return new Table({
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    alignment: AlignmentType.CENTER,
    borders,
    rows,
  });
}

function clipTable(clips: Clip[], doc: RequirementsDocument) {
  if (doc.languageAlt) {
    const w = [1531, 1531, 3600, 3600];
    return table(w, [
      new TableRow({
        tableHeader: true,
        children: [
          headerCell(`${doc.language} Title`, w[0]),
          headerCell(`${doc.languageAlt} Title`, w[1]),
          headerCell(`${doc.language} Transcript`, w[2]),
          headerCell(`${doc.languageAlt} Transcript`, w[3]),
        ],
      }),
      ...clips.map(
        (c) =>
          new TableRow({
            cantSplit: true,
            children: [
              nameCell(c.name, w[0]),
              nameCell(c.nameAlt || c.name, w[1]),
              transcriptCell(c.transcript, c.answer, w[2]),
              transcriptCell(c.transcriptAlt, c.answerAlt, w[3]),
            ],
          }),
      ),
    ]);
  }
  const w = [2400, 7862];
  return table(w, [
    new TableRow({ tableHeader: true, children: [headerCell("Title", w[0]), headerCell("Transcript", w[1])] }),
    ...clips.map(
      (c) => new TableRow({ cantSplit: true, children: [nameCell(c.name, w[0]), transcriptCell(c.transcript, c.answer, w[1])] }),
    ),
  ]);
}

function gridTable(widths: number[], headers: string[], rows: string[][]) {
  return table(widths, [
    new TableRow({ tableHeader: true, children: headers.map((h, i) => headerCell(h, widths[i])) }),
    ...rows.map(
      (cells) =>
        new TableRow({
          cantSplit: true,
          children: cells.map((c, i) =>
            bodyCell(widths[i], [new Paragraph({ spacing: { after: 0 }, children: runs(c, { color: INK, size: 17 }) })]),
          ),
        }),
    ),
  ]);
}
