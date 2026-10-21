import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import { validatePublicUrl } from "../security/url.js";
import { buildClaudePrompt } from "../services/claudePrompt.js";
import { assembleDocument } from "../services/document.js";
import { renderDocx } from "../services/docx.js";
import { crawlSite } from "../services/extractor.js";
import type { PageFetcher } from "../services/fetcher.js";
import { createSampleUpload, extractUploadText } from "../services/upload.js";
import {
  DocumentSchema,
  ModeSchema,
  PrimaryLanguageSchema,
  SecondaryLanguageSchema,
  type DraftGenerator,
} from "../types.js";

export interface ApiDeps {
  config: Config;
  fetchPage: PageFetcher;
  generateDraft: DraftGenerator;
  mock: boolean;
  now?: () => Date;
}

export function createApiRouter({ config, fetchPage, generateDraft, mock, now = () => new Date() }: ApiDeps) {
  const router = Router();
  const upload = createSampleUpload(config.MAX_UPLOAD_MB);
  const generateLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.RATE_LIMIT_PER_MIN,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: "RATE_LIMITED", message: "Too many requests. Please wait a minute and try again." },
      });
    },
  });

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", mock, maxUploadMb: config.MAX_UPLOAD_MB });
  });

  router.post("/generate", generateLimiter, upload, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = ModeSchema.safeParse(body.mode ?? "voice-agent");
    if (!mode.success) throw new AppError("INVALID_INPUT", "Mode must be \"voice-agent\" or \"voicemail\".");
    const url = validatePublicUrl(String(body.url ?? "")).toString();
    const language = PrimaryLanguageSchema.safeParse(body.language ?? "auto");
    const languageAlt = SecondaryLanguageSchema.safeParse(body.languageAlt ?? "English");
    if (!language.success || !languageAlt.success) throw new AppError("INVALID_INPUT", "Unsupported language.");
    const langs = {
      language: language.data,
      languageAlt: languageAlt.data === "none" ? null : languageAlt.data,
    };

    // Parse the sample first: it's cheap and fails fast on bad uploads.
    const sample = req.file ? await extractUploadText(req.file) : undefined;
    const crawl = await crawlSite(url, fetchPage, { maxPages: config.MAX_PAGES });

    const draft = await generateDraft({ mode: mode.data, websiteUrl: url, pages: crawl.pages, sample, ...langs });
    const document = assembleDocument(draft, {
      ...langs,
      mode: mode.data,
      websiteUrl: url,
      crawledUrls: crawl.pages.map((p) => p.url),
      now: now(),
    });

    res.json({
      document,
      claudePrompt: buildClaudePrompt(document),
      crawl: { pages: crawl.pages.map((p) => ({ url: p.url, title: p.title })), skipped: crawl.skipped },
      sampleUsed: Boolean(sample),
      mock,
    });
  });

  router.post("/claude-prompt", (req, res) => {
    res.json({ claudePrompt: buildClaudePrompt(DocumentSchema.parse(req.body)) });
  });

  router.post("/export/docx", async (req, res) => {
    const doc = DocumentSchema.parse(req.body);
    const buffer = await renderDocx(doc);
    const base = doc.clientName.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "client";
    res
      .type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .attachment(`${base}-${doc.mode}-script.docx`)
      .send(buffer);
  });

  return router;
}
