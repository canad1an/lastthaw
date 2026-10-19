import nodemailer, { type Transporter } from "nodemailer";
import { balance } from "@lastthaw/shared";
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

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const cfg = config();
  try {
    await getTransport().sendMail({ from: cfg.MAIL_FROM, to, subject, text, ...(html ? { html } : {}) });
  } catch (err) {
    // Mail failures must never break gameplay; log and move on.
    logger.error({ err, to: maskEmail(to), subject }, "failed to send mail");
  }
}

// ---------------------------------------------------------------------------
// Layout: every mail is the same dark card over an aurora band, with a title,
// a few paragraphs, an optional fact box and one button. Inline styles only,
// tables for the frame, so it reads the same in Gmail, Outlook and Apple Mail.
// A plain-text version goes alongside for clients that want it.
// ---------------------------------------------------------------------------

export interface MailDoc {
  subject: string;
  /** Shown in the inbox preview next to the subject. */
  preheader: string;
  greeting: string;
  paragraphs: string[];
  /** Label and value rows, shown in a box (when, where, code). */
  facts?: Array<{ label: string; value: string }>;
  cta?: { label: string; url: string };
  /** Small print under the button. */
  note?: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Day, date and time in UTC, readable: "Monday 19 October 2026, 00:00 UTC". */
export function whenUtc(d: Date): string {
  const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}

export function renderMail(doc: MailDoc): { subject: string; text: string; html: string } {
  const site = config().PUBLIC_URL;
  const text = [
    `${doc.greeting},`,
    "",
    ...doc.paragraphs.flatMap((p) => [p, ""]),
    ...(doc.facts?.length ? [...doc.facts.map((f) => `${f.label}: ${f.value}`), ""] : []),
    ...(doc.cta ? [`${doc.cta.label}: ${doc.cta.url}`, ""] : []),
    ...(doc.note ? [doc.note, ""] : []),
    `Last Thaw · ${site}`,
  ].join("\n");

  const facts = doc.facts?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:22px 0;border-collapse:separate;border:1px solid #1e3a5f;border-radius:10px;background:#0b1626;">
${doc.facts
  .map(
    (f) => `<tr><td style="padding:10px 16px;font:12px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#7dd3fc;text-transform:uppercase;letter-spacing:.18em;white-space:nowrap;">${esc(f.label)}</td><td style="padding:10px 16px;font:15px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#f1f5f9;">${esc(f.value)}</td></tr>`,
  )
  .join("\n")}
</table>`
    : "";
  const cta = doc.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;"><tr><td style="border-radius:8px;background:#f59e0b;background-image:linear-gradient(180deg,#fbbf24,#f59e0b);">
<a href="${esc(doc.cta.url)}" style="display:inline-block;padding:13px 26px;font:700 15px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;text-decoration:none;border-radius:8px;">${esc(doc.cta.label)}</a>
</td></tr></table>`
    : "";
  const note = doc.note ? `<p style="margin:18px 0 0;font:13px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#94a3b8;">${esc(doc.note)}</p>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${esc(doc.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#050b14;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${esc(doc.preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#050b14;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;">
<tr><td style="height:4px;border-radius:4px 4px 0 0;background:#38bdf8;background-image:linear-gradient(90deg,#38bdf8,#a5f3fc 40%,#818cf8 75%,#f472b6);"></td></tr>
<tr><td style="background:#0f1b2d;border:1px solid #1e3a5f;border-top:0;border-radius:0 0 14px 14px;padding:30px 32px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px;font:28px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#a5f3fc;">&#10052;</td>
<td style="font:700 18px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Last Thaw<div style="margin-top:4px;font:italic 12px/1.3 Georgia,serif;color:#7dd3fc;">Build before the ice does.</div></td>
</tr></table>
<h1 style="margin:26px 0 6px;font:700 26px/1.2 Georgia,'Times New Roman',serif;color:#ffffff;">${esc(doc.subject)}</h1>
<p style="margin:0 0 14px;font:16px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#cbd5e1;">${esc(doc.greeting)},</p>
${doc.paragraphs.map((p) => `<p style="margin:0 0 14px;font:16px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#e2e8f0;">${esc(p)}</p>`).join("\n")}
${facts}
${cta}
${note}
</td></tr>
<tr><td style="padding:18px 8px 0;font:12px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748b;text-align:center;">
Thirty days, a real map, and the ice closing in from the poles.<br>
<a href="${esc(site)}" style="color:#7dd3fc;text-decoration:none;">${esc(site.replace(/^https?:\/\//, ""))}</a> · <a href="${esc(site)}/how-to-play" style="color:#7dd3fc;text-decoration:none;">How to play</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: doc.subject, text, html };
}

// ---------------------------------------------------------------------------
// The mails
// ---------------------------------------------------------------------------

export function verificationMail(displayName: string, token: string, code: string) {
  const url = `${config().PUBLIC_URL}/verify?token=${encodeURIComponent(token)}`;
  return renderMail({
    subject: `${code} is your Last Thaw code`,
    preheader: `Your code is ${code}. Enter it on the site, or click the button, and the ice is yours to beat.`,
    greeting: `Hi ${displayName}`,
    paragraphs: [
      "Your account is ready. Confirm your email and you can join matches: pick a capital on the real map, set your five families to work, and build before the frost reaches your latitude.",
      `Enter this code where the site asks for it: ${code}. Or press the button below; either one confirms you.`,
    ],
    facts: [{ label: "Your code", value: code }],
    cta: { label: "Confirm my email", url },
    note: "The code and the link are valid for 24 hours. If you did not sign up, you can ignore this message.",
  });
}

export function startedMail(displayName: string, matchName: string, slug: string, speed: number, players: number) {
  const url = `${config().PUBLIC_URL}/match/${slug}`;
  const pace = speed > 1 ? `At ${speed}x a game day passes every ${Math.round(1440 / speed)} minutes, so check in often.` : "At real-time pace a game day is a real day: a few minutes each day keeps an empire growing.";
  return renderMail({
    subject: `${matchName} has started`,
    preheader: `The ice is moving. ${players} tribes are on the map; your five families are waiting.`,
    greeting: `Hi ${displayName}`,
    paragraphs: [
      `"${matchName}" has begun. ${players} tribes share the map and the ice is already moving toward the equator.`,
      `Nobody can attack you for the first ${balance.match.protectionDays} game days: set your workers, raise huts and a storehouse, research Fire making, and get settlers out to the land around you. ${pace}`,
    ],
    facts: [
      { label: "Match", value: matchName },
      { label: "Pace", value: speed > 1 ? `${speed}x` : "real time" },
      { label: "Length", value: `${balance.match.lengthDays} game days` },
    ],
    cta: { label: "Open the map", url },
    note: "You get no further mail about this match; the site and the Last Thaw Discord carry the news.",
  });
}

export function resetMail(displayName: string, token: string) {
  const url = `${config().PUBLIC_URL}/reset?token=${encodeURIComponent(token)}`;
  return renderMail({
    subject: "Reset your password",
    preheader: "Set a new Last Thaw password with one click.",
    greeting: `Hi ${displayName}`,
    paragraphs: ["Someone asked to reset the password on your Last Thaw account. If that was you, choose a new one here."],
    cta: { label: "Choose a new password", url },
    note: "The link is valid for 1 hour. If you did not ask for this, ignore this message and your password stays as it is.",
  });
}

export function inviteMail(displayName: string, token: string, days: number, game?: { name: string; code: string }, tournament?: { name: string; startsAt: Date }) {
  const site = config().PUBLIC_URL;
  const url = `${site}/reset?token=${encodeURIComponent(token)}`;
  return renderMail({
    subject: game ? `You are invited: ${game.name}` : tournament ? `You are invited: ${tournament.name}` : "You are invited to Last Thaw",
    preheader: "Matt Adam has opened a Last Thaw account for you. Set your password and pick your tribe.",
    greeting: `Hi ${displayName}`,
    paragraphs: [
      "Matt Adam has opened an account for you on Last Thaw, a game he created: thirty days of strategy on a real map of the world, with the ice closing in from the poles a little further every day.",
      "Set your password with the button below, then log in and pick your tribe name on your profile. You choose it once; it is how the other players know you in every match.",
      ...(game ? [`There is a private game waiting for you: "${game.name}". On the Matches page, enter the invite code to join it.`] : []),
      ...(tournament
        ? [
            `You are already registered for the tournament "${tournament.name}", which starts ${whenUtc(tournament.startsAt)}, and you are in whether or not you make it to the lobby. The lobby opens an hour before the start: come then to pick your capital on the map and meet the others in the chat, or let the game choose a starting region for you.`,
          ]
        : []),
    ],
    ...(game ? { facts: [{ label: "Game", value: game.name }, { label: "Invite code", value: game.code }] } : tournament ? { facts: [{ label: "Tournament", value: tournament.name }, { label: "Starts", value: whenUtc(tournament.startsAt) }, { label: "Lobby opens", value: "one hour before" }] } : {}),
    cta: { label: "Set my password", url },
    note: `The link is valid for ${days} days. The field manual at ${site}/how-to-play takes ten minutes.`,
  });
}

export function registrationMail(displayName: string, matchName: string, startsAt: Date, opensAt: Date) {
  const url = `${config().PUBLIC_URL}/matches`;
  return renderMail({
    subject: `Registered for ${matchName}`,
    preheader: `${matchName} starts ${whenUtc(startsAt)}. The lobby opens an hour before.`,
    greeting: `Hi ${displayName}`,
    paragraphs: [
      `You are registered for the tournament "${matchName}". Tournaments are the ranked matches: thirty real days against everyone who turns up, with the ice moving a little further toward the equator each day.`,
      "You are in: registered players are enrolled the moment the tournament starts, whether or not they come to the lobby. The lobby opens an hour before the start; come then to choose your capital on the map and meet the others in the chat, or let the game pick a starting region for you. We will remind you a day ahead, and again when the lobby opens.",
    ],
    facts: [
      { label: "Tournament", value: matchName },
      { label: "Starts", value: whenUtc(startsAt) },
      { label: "Lobby opens", value: whenUtc(opensAt) },
    ],
    cta: { label: "See the tournaments", url },
    note: "Changed your mind? Open the Matches page and withdraw your registration any time before the lobby opens.",
  });
}

export function reminderMail(displayName: string, matchName: string, startsAt: Date, kind: "day" | "hour") {
  const url = `${config().PUBLIC_URL}/matches`;
  if (kind === "hour") {
    return renderMail({
      subject: `The lobby is open: ${matchName}`,
      preheader: `${matchName} starts in about an hour. Join now and pick your capital.`,
      greeting: `Hi ${displayName}`,
      paragraphs: [`"${matchName}" starts in about an hour. The lobby is open now: join, choose where your five families begin, and see who else is in.`, "You are in either way: if you do not come, you are enrolled at the start and a starting region is picked for you."],
      facts: [
        { label: "Tournament", value: matchName },
        { label: "Starts", value: whenUtc(startsAt) },
      ],
      cta: { label: "Go to the lobby", url },
    });
  }
  return renderMail({
    subject: `Tomorrow: ${matchName}`,
    preheader: `${matchName} starts ${whenUtc(startsAt)}. The lobby opens an hour before.`,
    greeting: `Hi ${displayName}`,
    paragraphs: [`"${matchName}" starts tomorrow. The lobby opens an hour before the start; we will mail you again the moment it does.`, "Until then, ten minutes with the field manual is the best preparation there is."],
    facts: [
      { label: "Tournament", value: matchName },
      { label: "Starts", value: whenUtc(startsAt) },
    ],
    cta: { label: "Read how to play", url: `${config().PUBLIC_URL}/how-to-play` },
  });
}
