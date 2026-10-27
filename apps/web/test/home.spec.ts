import { test, expect } from "@playwright/test";

/**
 * The home page in a browser without Path2D (the Lightpanda headless browser, 2026-10-26): the hero map
 * cannot draw, but the page must still render instead of crashing into the error screen.
 */
test("home page renders without Path2D", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { Path2D?: unknown }).Path2D;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("canvas").first()).toBeAttached();
  await expect(page.getByRole("heading").first()).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
  expect(errors).toEqual([]);
});
