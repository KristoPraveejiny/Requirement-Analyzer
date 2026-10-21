import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  // Empty string is treated as "not set" so a blank line in .env enables mock mode.
  OPENROUTER_API_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  OPENROUTER_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5.5"),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(25).default(5),
  MAX_PAGES: z.coerce.number().int().min(1).max(20).default(8),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
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
