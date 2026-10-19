/**
 * Send one of the mails to an address, to see it in a real inbox.
 *
 *   node dist/scripts/previewMail.js registration you@example.com "Frozen Vanguard"
 *   kinds: welcome, reset, invite, registration, reminder-day, reminder-hour
 */
import { eq } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { matches } from "../db/schema.js";
import { inviteMail, registrationMail, reminderMail, resetMail, sendMail, verificationMail } from "../mail.js";
import { joinOpensAt } from "../matches/registrations.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/previewMail.js") || arg.endsWith("/previewMail.ts")) {
  const [kind, to, matchName] = process.argv.slice(2);
  if (!kind || !to) {
    console.error("usage: previewMail <kind> <to> [match name]");
    process.exit(2);
  }
  const db = createDb();
  let startsAt = new Date(Date.now() + 2 * 86400_000);
  let name = matchName ?? "Frozen Vanguard";
  if (matchName) {
    const [m] = await db.select({ name: matches.name, startsAt: matches.startsAt }).from(matches).where(eq(matches.name, matchName)).limit(1);
    if (m) {
      name = m.name;
      startsAt = m.startsAt;
    }
  }
  const who = "Canad1an";
  const mail =
    kind === "welcome"
      ? verificationMail(who, "sample-token", "123456")
      : kind === "reset"
        ? resetMail(who, "sample-token")
        : kind === "invite"
          ? inviteMail(who, "sample-token", 7, { name, code: "4903C504" })
          : kind === "reminder-day"
            ? reminderMail(who, name, startsAt, "day")
            : kind === "reminder-hour"
              ? reminderMail(who, name, startsAt, "hour")
              : registrationMail(who, name, startsAt, joinOpensAt(startsAt));
  await sendMail(to, mail.subject, mail.text, mail.html);
  console.log(JSON.stringify({ kind, to, subject: mail.subject }));
  await db.close();
}
