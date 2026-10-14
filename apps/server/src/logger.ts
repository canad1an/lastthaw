import pino from "pino";

const pretty = process.env.NODE_ENV !== "production";

export const logger = pino(
  pretty
    ? { level: process.env.LOG_LEVEL ?? "info", transport: { target: "pino-pretty", options: { colorize: true } } }
    : { level: process.env.LOG_LEVEL ?? "info" },
);
