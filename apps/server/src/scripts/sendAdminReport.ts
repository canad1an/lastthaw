/**
 * Mail an operations report (the nightly fixer's, for one) from admin@lastthaw.com to admin@lastthaw.com,
 * through the game's own Postmark server. The body is read from stdin.
 *
 *   docker compose ... --profile app run --rm --no-deps -T api node dist/scripts/sendAdminReport.js "<subject>" < report.txt
 */
import { sendAdminReport } from "../mail.js";

const arg = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (arg.endsWith("/sendAdminReport.js") || arg.endsWith("/sendAdminReport.ts")) {
  const subject = process.argv[2];
  if (!subject) {
    console.error('usage: sendAdminReport "<subject>" < body.txt');
    process.exit(2);
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    console.error("sendAdminReport: empty body on stdin");
    process.exit(2);
  }
  await sendAdminReport(subject, body);
  console.log(`sent "${subject}" to admin@lastthaw.com`);
  process.exit(0);
}
