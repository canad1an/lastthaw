import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config.js";
import { logger, maskEmail } from "./logger.js";

let transport: Transporter | undefined;

function getTransport() {
  if (!transport) {
    const cfg = config();
    transport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_PORT === 465,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const cfg = config();
  try {
    await getTransport().sendMail({ from: cfg.MAIL_FROM, to, subject, text });
  } catch (err) {
    // Mail failures must never break gameplay; log and move on.
    logger.error({ err, to: maskEmail(to), subject }, "failed to send mail");
  }
}

export function verificationMail(displayName: string, token: string) {
  const url = `${config().PUBLIC_URL}/verify?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your Last Thaw account",
    text: `Hi ${displayName},\n\nConfirm your email to join matches:\n\n${url}\n\nThe link is valid for 24 hours. If you did not sign up, ignore this message.\n`,
  };
}

export function resetMail(displayName: string, token: string) {
  const url = `${config().PUBLIC_URL}/reset?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your Last Thaw password",
    text: `Hi ${displayName},\n\nReset your password here:\n\n${url}\n\nThe link is valid for 1 hour. If you did not ask for this, ignore this message.\n`,
  };
}
