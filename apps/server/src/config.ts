import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  SESSION_SECRET: z.string().min(16),
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("Last Thaw <noreply@lastthaw.com>"),
  PUBLIC_URL: z.string().url().default("http://localhost:5173"),
  /** Discord webhook the AI tribes post through during tournaments; unset means they stay quiet. */
  DISCORD_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .pipe(z.string().url().optional()),
  /** Load harness only: no per-address rate limits, since every simulated player comes from one machine. Never set in production. */
  LOAD_TEST: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  DEV_TOOLS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

/** Parsed, validated environment. Throws at startup if something required is missing. */
export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
      throw new Error(`Invalid environment:\n${lines.join("\n")}`);
    }
    if (parsed.data.NODE_ENV === "production" && parsed.data.DEV_TOOLS) {
      throw new Error("DEV_TOOLS must not be enabled in production");
    }
    cached = parsed.data;
  }
  return cached;
}
