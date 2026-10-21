import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { AppError } from "../errors.js";

export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown API endpoint." } });
};

/** Maps every error to a safe JSON response; internals are only logged. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const send = (status: number, code: string, message: string) =>
    res.status(status).json({ error: { code, message } });

  if (err instanceof AppError) return send(err.status, err.code, err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return send(413, "FILE_TOO_LARGE", "The uploaded file is too large.");
    return send(400, "INVALID_UPLOAD", "Upload rejected. Send a single file in the \"sample\" field.");
  }

  if (err instanceof ZodError) {
    return send(400, "INVALID_INPUT", "The request data is invalid.");
  }

  const type = (err as { type?: string })?.type;
  if (type === "entity.too.large") return send(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
  if (type === "entity.parse.failed") return send(400, "INVALID_JSON", "The request body is not valid JSON.");

  console.error("Unhandled error", err);
  return send(500, "INTERNAL", "Something went wrong. Please try again.");
};
