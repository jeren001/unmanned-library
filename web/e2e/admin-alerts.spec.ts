import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * Quiet alerts: the simulator is off until an admin starts it, old alerts never toast on load,
 * new critical/warning alerts toast at most two at a time for 5 s, and the bell keeps them all.
 */

test.use({ contextOptions: { reducedMotion: "reduce" } });

const toasts = (page: Page) => page.locator(".qa-toast-viewport .qa-toast");

async function signInAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByRole("tab", { name: /Admin|管理员/ }).click();
  await page.locator('input[name="username"]').fill("admin");
  await page.locator('input[name="password"]').fill("admin123");
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin/);
  await expect(page.locator(".admin-sidebar")).toBeVisible();
}

test("simulator is off by default and old alerts do not toast on page load", async ({ page }) => {
  await signInAsAdmin(page);
  const status = await page.request.get("/api/simulator/status");
  expect((await status.json()).data.running).toBe(false);

  // The seed has open alerts: they belong in the bell, not in toasts.
  await page.waitForTimeout(2_500);
  await expect(toasts(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".admin-sidebar")).toBeVisible();
  await page.waitForTimeout(2_500);
  await expect(toasts(page)).toHaveCount(0);

  const count = Number(await page.locator(".admin-bell em").innerText());
  expect(count).toBeGreaterThan(0);
  await page.locator(".admin-bell").click();
  await expect(page.locator(".admin-bell-panel li")).toHaveCount(Math.min(count, 200));
});

test("new alerts toast at most two at a time and disappear after 5 s", async ({ page }) => {
  await signInAsAdmin(page);
  await page.waitForTimeout(1_000);

  let most = 0;
  let watching = true;
  const watch = (async () => {
    while (watching) {
      most = Math.max(most, await toasts(page).count());
      await page.waitForTimeout(50);
    }
  })();

  const branches = ["branch-east", "branch-west", "branch-sunshine"];
  for (const branchId of branches) {
    for (const scenario of ["smoke_spike", "illegal_exit", "network_outage"]) {
      const response = await page.request.post("/api/simulator/scenario", { data: { scenario, branchId } });
      expect(response.status()).toBe(202);
    }
  }
  await expect(toasts(page).first()).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(1_000);
  watching = false;
  await watch;
  expect(most).toBeGreaterThan(0);
  expect(most).toBeLessThanOrEqual(2);

  // Nothing new is raised now, so every toast is gone within ~5 s.
  await expect(toasts(page)).toHaveCount(0, { timeout: 6_000 });
  await page.request.post("/api/simulator/scenario", { data: { scenario: "recover", branchId: "branch-east" } });
});

test("simulator event log is a burgundy-on-paper slip", async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto("/admin/settings/simulator");
  await page.getByRole("button", { name: /启动模拟器|Start simulator/ }).click();
  await page.getByRole("button", { name: /暂停模拟器|Pause simulator/ }).click();
  const log = page.locator(".admin-sim-log .admin-test-log");
  await expect(log.locator("li").first()).toBeVisible();
  const style = await log.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, color: computed.color, font: computed.fontFamily };
  });
  expect(style.background).toBe("rgb(255, 251, 243)");
  expect(style.color).toBe("rgb(90, 18, 32)");
  expect(style.font).toMatch(/mono/i);
  const status = await page.request.get("/api/simulator/status");
  expect((await status.json()).data.running).toBe(false);
});
