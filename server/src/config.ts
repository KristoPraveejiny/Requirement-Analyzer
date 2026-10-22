import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  // Bind all IPv4 interfaces so a hosting platform's proxy can reach the server.
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  // Empty string is treated as "not set" so a blank line in .env enables mock mode.
  GEMINI_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  // Stable, and free-tier eligible on the Gemini API pricing page (checked 2026-10-22).
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.8-flash"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(5),
  MAX_PAGES: z.coerce.number().int().min(1).max(20).default(8),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  // Per-page website fetch timeout and AI request timeout. Lower them on platforms
  // with a hard request limit (e.g. Netlify Functions: 60 s in total).
  FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(180_000),
  // Optional budget for a whole /api/generate request (upload + crawl + AI). Unset = no overall limit.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).optional(),
  // Express "trust proxy" setting: "false", a hop count, or a comma-separated list of subnets.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v): boolean | number | string =>
      v === "false" ? false : v === "true" ? true : /^\d+$/.test(v) ? Number(v) : v,
    ),
  STATIC_DIR: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
