import { test, expect, request as playwrightRequest, type Page, type APIRequestContext } from "@playwright/test";
import postgres from "postgres";

/**
 * The match page on phones: every screen must fit the width of the device. A screen that is wider than
 * the viewport scrolls sideways and hides its right edge, which is exactly the bug a desktop check misses.
 *
 * Each device profile gets its own account and match, made through the API and removed afterwards.
 */
const API = "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://lastthaw:lastthaw@localhost:5432/lastthaw";
const PASSWORD = "phone-check-pass-1";

interface Fixture {
  email: string;
  matchId: string;
  slug: string;
}

async function makeFixture(project: string): Promise<Fixture> {
  const stamp = Date.now().toString(36);
  const email = `pw-${project}-${stamp}@example.test`;
  const api: APIRequestContext = await playwrightRequest.newContext({ baseURL: API });
  const reg = await api.post("/api/auth/register", { data: { email, password: PASSWORD, displayName: `Phone ${project} ${stamp}`.slice(0, 24) } });
  if (reg.status() !== 201) throw new Error(`register: ${reg.status()} ${await reg.text()}`);
  // The beta gate: the account is verified and approved straight in the database, as the admin page would do.
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`update users set email_verified_at = now(), approved_at = now() where email = ${email}`;
  } finally {
    await sql.end();
  }
  const created = await api.post("/api/matches", { data: { name: `Phone check ${project} ${stamp}`, speed: 180, startsInMinutes: 60, kind: "private", aiFillTo: 6, aiDifficulty: "easy" } });
  if (created.status() !== 201) throw new Error(`create match: ${created.status()} ${await created.text()}`);
  const { id: matchId } = (await created.json()) as { id: string };
  const joined = await api.post(`/api/matches/${matchId}/join`, { data: {} });
  if (![200, 201].includes(joined.status())) throw new Error(`join: ${joined.status()} ${await joined.text()}`);
  const started = await api.post(`/api/matches/${matchId}/dev/start`, { data: {} });
  if (started.status() !== 200) throw new Error(`start: ${started.status()} ${await started.text()} (the API needs DEV_TOOLS=true)`);
  const list = (await (await api.get("/api/matches")).json()) as Array<{ id: string; slug?: string }>;
  const slug = list.find((m) => m.id === matchId)?.slug || matchId;
  await api.dispose();
  return { email, matchId, slug };
}

async function dropFixture(f: Fixture): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from matches where id = ${f.matchId}::uuid`;
    await sql`delete from users where email = ${f.email}`;
  } finally {
    await sql.end();
  }
}

/** The three things that must hold on every phone screen: no sideways scroll, the tab bar on screen, nothing clipped at the right edge. */
async function expectFits(page: Page, label: string) {
  const viewport = page.viewportSize()!;
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const screen = document.querySelector<HTMLElement>("[data-phone-screen] [data-phone-body]");
    return {
      doc: doc.scrollWidth - doc.clientWidth,
      body: body.scrollWidth - body.clientWidth,
      screen: screen ? screen.scrollWidth - screen.clientWidth : 0,
      screenRight: screen ? screen.getBoundingClientRect().right : 0,
    };
  });
  expect.soft(m.doc, `${label}: the page scrolls sideways by ${m.doc}px`).toBeLessThanOrEqual(0);
  expect.soft(m.body, `${label}: the body scrolls sideways by ${m.body}px`).toBeLessThanOrEqual(0);
  expect.soft(m.screen, `${label}: the screen scrolls sideways by ${m.screen}px`).toBeLessThanOrEqual(0);
  if (m.screenRight) expect.soft(m.screenRight, `${label}: the screen runs past the right edge`).toBeLessThanOrEqual(viewport.width + 1);
  const bar = page.getByRole("navigation", { name: "Game sections" });
  await expect(bar, `${label}: the tab bar is missing`).toBeVisible();
  const box = await bar.boundingBox();
  expect.soft(box && box.y + box.height, `${label}: the tab bar sits below the viewport`).toBeLessThanOrEqual(viewport.height + 1);
  expect.soft(box && box.x + box.width, `${label}: the tab bar runs past the right edge`).toBeLessThanOrEqual(viewport.width + 1);
  await page.screenshot({ path: `test-results/phone/${test.info().project.name}-${label}.png` });
}

/** Go back one screen with the header's arrow. */
async function back(page: Page) {
  await page.getByRole("button", { name: "Back" }).first().click();
}

test.describe("the match page on a phone", () => {
  let f: Fixture;
  test.beforeAll(async ({}, info) => {
    f = await makeFixture(info.project.name);
  });
  test.afterAll(async () => {
    if (f) await dropFixture(f);
  });

  test("every screen fits the width of the phone", async ({ page }, info) => {
    // In through the real login form.
    await page.goto("/login");
    await page.getByLabel("Email").fill(f.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByLabel("Password").press("Enter");
    await page.waitForURL(/\/matches/);
    await page.goto(`/match/${f.slug}`);
    // The first-visit guide covers the map; close it.
    const go = page.getByRole("button", { name: "Let's go" });
    await go.waitFor({ state: "visible", timeout: 20_000 });
    await go.click();
    await expectFits(page, "map");

    // The current match stays in the top bar on a phone, without opening the menu.
    await expect(page.getByRole("link", { name: /^Play · / }).first()).toBeVisible();

    // The region screen and each of its tabs.
    await page.getByRole("button", { name: "Region" }).click();
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await expectFits(page, "region-overview");
    for (const tab of ["build", "train", "units"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await expectFits(page, `region-${tab}`);
    }
    // Picking a target drops to the map and comes back to the units tab with the pick made.
    await page.getByRole("button", { name: "Pick target" }).click();
    await expect(page.getByText("Tap a region to target it")).toBeVisible();
    await expectFits(page, "picking");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Pick target" })).toBeVisible();
    await back(page);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);

    // The two tabs with a screen of their own.
    for (const tab of ["Empire", "Research"]) {
      await page.getByRole("button", { name: tab }).click();
      await expectFits(page, tab.toLowerCase());
      await back(page);
    }

    // Everything behind More, and Back returns to the grid each time.
    await page.getByRole("button", { name: "More" }).click();
    await expectFits(page, "menu");
    const grid = page.locator("[data-phone-screen] [data-phone-body] button");
    const labels = (await grid.allInnerTexts()).map((t) => t.split("\n")[0]!.trim());
    expect(labels.length, "the menu grid is empty").toBeGreaterThan(5);
    for (const label of labels) {
      await grid.filter({ hasText: new RegExp(`^${label}`) }).first().click();
      await expect(page.locator("[data-phone-title]")).not.toHaveText("Menu");
      await expectFits(page, `menu-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`);
      await back(page);
      await expect(page.locator("[data-phone-title]")).toHaveText("Menu");
    }
    await back(page);
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    info.annotations.push({ type: "device", description: `${info.project.name} ${page.viewportSize()!.width}x${page.viewportSize()!.height}` });
  });
});
