import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The server's crontab lives in the repo and the deploy installs it whole. On 2026-10-16 a Matomo line installed by
// hand replaced the crontab on the box and the nightly backups stopped unnoticed for two days; these checks make sure
// every job the box needs is in the file the deploy installs, and that the deploy really installs it.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => fs.readFileSync(path.join(repo, p), "utf8");

describe("deploy/crontab", () => {
  const lines = read("deploy/crontab")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
  const jobs = lines.map((l) => {
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/.exec(l);
    expect(m, `not a cron line: ${l}`).not.toBeNull();
    return { schedule: m![1]!, command: m![2]! };
  });
  const job = (script: string) => jobs.find((j) => j.command.includes(script));

  it("every line is schedule plus command, running in the repo with its output logged", () => {
    for (const j of jobs) {
      expect(j.schedule.split(/\s+/)).toHaveLength(5);
      expect(j.command).toMatch(/^cd ~\/lastthaw && /);
      expect(j.command).toMatch(/>> ~\/backups\/[a-z-]+\.log 2>&1$/);
    }
  });

  it("backs the database up every night", () => {
    const b = job("deploy/backup.sh");
    expect(b).toBeDefined();
    const [min, hour, dom, mon, dow] = b!.schedule.split(/\s+/);
    expect([dom, mon, dow]).toEqual(["*", "*", "*"]);
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
    expect(Number(min)).toBeGreaterThanOrEqual(0);
    expect(fs.existsSync(path.join(repo, "deploy/backup.sh"))).toBe(true);
  });

  it("restores a backup into a scratch database every month", () => {
    const r = job("deploy/restore-check.sh");
    expect(r).toBeDefined();
    const [, , dom, mon, dow] = r!.schedule.split(/\s+/);
    expect(dom).not.toBe("*");
    expect([mon, dow]).toEqual(["*", "*"]);
  });

  it("archives Matomo reports", () => {
    expect(job("core:archive")).toBeDefined();
  });

  it("is installed whole by the deploy, so a job added by hand cannot replace it", () => {
    const deploy = read("deploy/deploy.sh");
    expect(deploy).toMatch(/^\s*crontab deploy\/crontab/m);
    expect(deploy).toMatch(/mkdir -p "\$HOME\/backups"/);
  });
});
