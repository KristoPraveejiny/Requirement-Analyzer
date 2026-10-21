import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import type { Config } from "./config.js";
import { apiNotFound, errorHandler } from "./middleware/errors.js";
import { createApiRouter } from "./routes/api.js";
import { createSafeFetcher, type PageFetcher } from "./services/fetcher.js";
import { mockGenerator } from "./services/mockGenerator.js";
import { createOpenRouterGenerator } from "./services/openrouter.js";
import type { DraftGenerator } from "./types.js";

export interface AppDeps {
  config: Config;
  fetchPage?: PageFetcher;
  generateDraft?: DraftGenerator;
  now?: () => Date;
}

// Resolves to <repo>/client/dist from both server/src (tsx) and server/dist (built).
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../client/dist", import.meta.url));

export function createApp({ config, fetchPage, generateDraft, now }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(helmet());

  const mock = !generateDraft && !config.OPENROUTER_API_KEY;
  const generator =
    generateDraft ??
    (config.OPENROUTER_API_KEY
      ? createOpenRouterGenerator({
          apiKey: config.OPENROUTER_API_KEY,
          model: config.OPENROUTER_MODEL,
          timeoutMs: config.LLM_TIMEOUT_MS,
        })
      : mockGenerator);

  app.use(
    "/api",
    express.json({ limit: "1mb" }),
    createApiRouter({ config, fetchPage: fetchPage ?? createSafeFetcher({ timeoutMs: config.FETCH_TIMEOUT_MS }), generateDraft: generator, mock, now }),
    apiNotFound,
  );

  // Once the client is built, serve it from the same origin (single-process deployment).
  const staticDir = path.resolve(config.STATIC_DIR ?? DEFAULT_STATIC_DIR);
  if (config.NODE_ENV !== "test" && existsSync(path.join(staticDir, "index.html"))) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(staticDir, "index.html")));
  }

  app.use(errorHandler);
  return app;
}
