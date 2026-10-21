import path from "node:path";
import multer from "multer";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { AppError } from "../errors.js";

export const ALLOWED_EXTENSIONS = [".docx", ".pdf", ".txt", ".md"] as const;
type Ext = (typeof ALLOWED_EXTENSIONS)[number];

const MAX_TEXT_CHARS = 20_000;
const PARSE_TIMEOUT_MS = 15_000;

/** Multer middleware for a single in-memory file field "sample"; nothing touches disk. */
export function createSampleUpload(maxUploadMb: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.floor(maxUploadMb * 1024 * 1024), files: 1, fields: 10, fieldSize: 16 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (getExtension(file.originalname)) cb(null, true);
      else cb(unsupported());
    },
  }).single("sample");
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
}

/** Validates extension and file signature, then returns the extracted plain text. */
export async function extractUploadText(file: UploadedFile): Promise<string> {
  const ext = getExtension(file.originalname);
  if (!ext) throw unsupported();
  if (file.buffer.length === 0) throw new AppError("INVALID_UPLOAD", "The uploaded file is empty.");
  assertSignature(ext, file.buffer);

  let text: string;
  try {
    text = await withTimeout(parse(ext, file.buffer), PARSE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("INVALID_UPLOAD", "The uploaded file could not be read. Is it corrupted?");
  }

  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new AppError("INVALID_UPLOAD", "No readable text was found in the uploaded file.");
  return text.slice(0, MAX_TEXT_CHARS);
}

export function getExtension(filename: string): Ext | null {
  const ext = path.extname(filename ?? "").toLowerCase();
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext) ? (ext as Ext) : null;
}

function assertSignature(ext: Ext, buf: Buffer): void {
  let ok: boolean;
  if (ext === ".pdf") {
    ok = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  } else if (ext === ".docx") {
    // ZIP local-file header, and a Word document part somewhere in the archive.
    ok = buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
      buf.includes("word/document.xml", 0, "latin1");
  } else {
    ok = isPlainText(buf);
  }
  if (!ok) {
    throw new AppError("INVALID_UPLOAD", `The file content doesn't match its ${ext} extension.`);
  }
}

function isPlainText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

async function parse(ext: Ext, buf: Buffer): Promise<string> {
  switch (ext) {
    case ".docx":
      return (await mammoth.extractRawText({ buffer: buf })).value;
    case ".pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      return (await extractText(pdf, { mergePages: true })).text;
    }
    default:
      return buf.toString("utf8").replace(/^﻿/, "");
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError("INVALID_UPLOAD", "The uploaded file took too long to process.")),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function unsupported() {
  return new AppError(
    "UNSUPPORTED_FILE",
    `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`,
  );
}
