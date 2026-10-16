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

export function inviteMail(displayName: string, token: string, days: number, game?: { name: string; code: string }) {
  const url = `${config().PUBLIC_URL}/reset?token=${encodeURIComponent(token)}`;
  const gameLine = game ? `
Matt has a private game waiting for you, "${game.name}". In the lobby at ${config().PUBLIC_URL}/matches enter the invite code ${game.code} to join it.
` : "";
  return {
    subject: game ? `You are invited to Last Thaw: ${game.name}` : "You are invited to Last Thaw",
    text: `Hi ${displayName},

Matt has opened a Last Thaw account for you. Thirty days, a real map, and the ice closing in from the poles.

Set your password here:

${url}

Then log in, open your profile and pick your tribe name. You choose it once; it is how the other players know you in every match.
${gameLine}
The link is valid for ${days} days. The field manual is at ${config().PUBLIC_URL}/how-to-play.
`,
  };
}

const when = (d: Date) => `${d.toUTCString().replace(" GMT", " UTC")}`;

export function registrationMail(displayName: string, matchName: string, startsAt: Date, opensAt: Date) {
  const url = `${config().PUBLIC_URL}/matches`;
  return {
    subject: `Registered: ${matchName}`,
    text: `Hi ${displayName},\n\nYou are registered for the tournament "${matchName}".\n\nIt starts ${when(startsAt)}. The lobby opens an hour before, at ${when(opensAt)}: that is when you join, pick your capital and meet the others. We will remind you a day ahead and again when the lobby opens.\n\n${url}\n`,
  };
}

export function reminderMail(displayName: string, matchName: string, startsAt: Date, kind: "day" | "hour") {
  const url = `${config().PUBLIC_URL}/matches`;
  if (kind === "hour") {
    return {
      subject: `The lobby is open: ${matchName}`,
      text: `Hi ${displayName},\n\n"${matchName}" starts in about an hour, at ${when(startsAt)}. The lobby is open now: join, pick your capital and get ready.\n\n${url}\n`,
    };
  }
  return {
    subject: `Tomorrow: ${matchName}`,
    text: `Hi ${displayName},\n\n"${matchName}" starts tomorrow, ${when(startsAt)}. The lobby opens an hour before the start; we will mail you again then.\n\n${url}\n`,
  };
}

export function resetMail(displayName: string, token: string) {
  const url = `${config().PUBLIC_URL}/reset?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your Last Thaw password",
    text: `Hi ${displayName},\n\nReset your password here:\n\n${url}\n\nThe link is valid for 1 hour. If you did not ask for this, ignore this message.\n`,
  };
}
