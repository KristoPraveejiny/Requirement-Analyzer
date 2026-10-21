import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractUploadText, getExtension } from "../src/services/upload.js";

async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Builds a minimal valid single-page PDF with correct xref offsets. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const file = (originalname: string, buffer: Buffer) => ({ originalname, buffer });

describe("getExtension", () => {
  it("accepts only the whitelisted extensions, case-insensitively", () => {
    expect(getExtension("Sample.DOCX")).toBe(".docx");
    expect(getExtension("notes.md")).toBe(".md");
    expect(getExtension("evil.exe")).toBeNull();
    expect(getExtension("doc.pdf.exe")).toBeNull();
    expect(getExtension("noext")).toBeNull();
    expect(getExtension("old.doc")).toBeNull();
  });
});

describe("extractUploadText", () => {
  it("extracts text from .txt and .md (strips BOM, normalises whitespace)", async () => {
    const txt = Buffer.from("﻿Greeting:\r\n\r\n\r\n\r\nHello   there", "utf8");
    expect(await extractUploadText(file("a.txt", txt))).toBe("Greeting:\n\nHello there");
    expect(await extractUploadText(file("a.md", Buffer.from("# Title\n- item")))).toBe("# Title\n- item");
  });

  it("extracts text from .docx", async () => {
    const docx = await makeDocx(["Call flow sample", "Ask for the caller name"]);
    const text = await extractUploadText(file("sample.docx", docx));
    expect(text).toContain("Call flow sample");
    expect(text).toContain("Ask for the caller name");
  });

  it("extracts text from .pdf", async () => {
    const text = await extractUploadText(file("sample.pdf", makePdf("Voicemail script sample")));
    expect(text).toContain("Voicemail script sample");
  });

  it("rejects unsupported extensions", async () => {
    await expect(extractUploadText(file("x.exe", Buffer.from("MZ")))).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE",
    });
  });

  it.each([
    ["fake.pdf", Buffer.from("not really a pdf")],
    ["fake.docx", Buffer.from("PK\u0003\u0004 but no word part", "latin1")],
    ["zip.docx", Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])],
    ["binary.txt", Buffer.from([0x48, 0x00, 0x49])],
    ["latin1.md", Buffer.from([0xff, 0xfe, 0xfd])],
    ["exe.pdf", Buffer.from("MZ\x90\x00", "latin1")],
  ])("rejects %s with a mismatched signature", async (name, buf) => {
    await expect(extractUploadText(file(name, buf))).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
  });

  it("rejects empty and corrupted files", async () => {
    await expect(extractUploadText(file("e.txt", Buffer.alloc(0)))).rejects.toMatchObject({
      code: "INVALID_UPLOAD",
    });
    await expect(extractUploadText(file("w.txt", Buffer.from("   \n  ")))).rejects.toMatchObject({
      code: "INVALID_UPLOAD",
    });
    const broken = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.from("word/document.xml garbage")]);
    await expect(extractUploadText(file("broken.docx", broken))).rejects.toMatchObject({
      code: "INVALID_UPLOAD",
    });
    await expect(extractUploadText(file("broken.pdf", Buffer.from("%PDF-1.4 garbage")))).rejects.toMatchObject({
      code: "INVALID_UPLOAD",
    });
  });

  it("caps extracted text length", async () => {
    const text = await extractUploadText(file("long.txt", Buffer.from("a".repeat(50_000))));
    expect(text.length).toBe(20_000);
  });
});
