import { test, expect } from "@playwright/test";

/**
 * The replay of a match on Pangaea (2026-11-12, "map pangaea is not loaded"): the page mounts its map on Earth while
 * the replay is still on its way, then learns the match was played on Pangaea. It must show the loading line until
 * that map's files arrive instead of drawing a map that is not there and falling into the error screen.
 */
test("replay of a Pangaea match waits for its map", async ({ page }) => {
  await page.route("**/api/matches/*/replay", async (route) => {
    // Late enough that the page has already drawn Earth.
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        match: { id: "00000000-0000-4000-8000-000000000001", name: "Grey Snowfall", status: "finished", speed: 1, finishedAt: "2026-10-31T00:00:00.000Z", winnerPlayerId: null, map: "pangaea" },
        players: [{ id: "p1", name: "Ironvale", isAi: true }],
        frames: [
          { day: 0, changes: {} },
          { day: 1, changes: {} },
        ],
      }),
    });
  });
  // The map's own files arrive later still, so there is a moment when the match is known and its map is not.
  await page.route("**/map/pangaea/world.json", async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let mapFetched = false;
  page.on("response", (r) => {
    if (r.url().includes("/map/pangaea/world.json") && r.ok()) mapFetched = true;
  });
  await page.goto("/match/grey-snowfall/replay");
  // The match is known, its map is still on its way: the loading line, not a crash.
  await expect(page.getByText("Grey Snowfall", { exact: true })).toBeVisible();
  await expect(page.getByText("Loading the map...")).toBeVisible();
  await expect(page.getByText("Loading the map...")).toHaveCount(0);
  expect(mapFetched).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
  expect(errors).toEqual([]);
});
