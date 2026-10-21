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
  MAIL_FROM: z.string().default("Last Thaw <admin@lastthaw.com>"),
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
  /** How many new players (counted from the first one after this shipped) get a game of their own made at sign-up. 0 turns it off. */
  WELCOME_MATCHES: z.coerce.number().int().min(0).default(50),
  /** How long after the email is confirmed that welcome game starts. */
  WELCOME_MATCH_MINUTES: z.coerce.number().int().min(1).default(30),
  /** A welcome game is cancelled or ended early once its player has not been seen for this long. */
  WELCOME_MATCH_IDLE_HOURS: z.coerce.number().int().min(1).default(24),
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
