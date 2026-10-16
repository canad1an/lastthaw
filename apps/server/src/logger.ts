import pino from "pino";

const pretty = process.env.NODE_ENV !== "production";

const redact = { paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-device']", "res.headers['set-cookie']"], censor: "[redacted]" };

export const logger = pino(
  pretty
    ? { level: process.env.LOG_LEVEL ?? "info", redact, transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: process.env.LOG_LEVEL ?? "info", redact },
);

/** For log lines: keep the domain, hide the mailbox. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  return `${(user ?? "").slice(0, 1)}***@${domain ?? "?"}`;
}
