import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * One reader session for both entrances: a card login on /login lands on kiosk Home already identified,
 * /kiosk reuses an existing session, Log out returns to /login, and inactivity returns to the kiosk idle screen.
 */

test.use({ contextOptions: { reducedMotion: "reduce" } });

const home = (page: Page) => page.locator(".kiosk-catalog");
const identifyStep = (page: Page) => page.getByLabel("Reader card number");

async function readerLogin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("读者证号").fill("20240001");
  await page.getByRole("button", { name: "进入", exact: true }).click();
}

test("a reader login on /login opens kiosk Home with the reader's name and no second identify step", async ({ page }) => {
  const cardLogins: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/auth/card-login")) cardLogins.push(request.url()); });

  await readerLogin(page);
  await page.waitForURL(/\/kiosk$/);
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("你好，林知秋");
  await expect(identifyStep(page)).toHaveCount(0);
  await expect(page.locator(".kiosk-idle")).toHaveCount(0);
  await expect(page.getByText(/欢迎，|Welcome,/)).toHaveCount(0);
  expect(cardLogins).toHaveLength(1);

  // Reopening /kiosk keeps the same session.
  await page.goto("/kiosk");
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("你好，林知秋");
  expect(cardLogins).toHaveLength(1);

  // Log out clears the session; /kiosk then starts at the idle screen again.
  await page.getByRole("button", { name: /^(退出|Log out)$/ }).click();
  await page.waitForURL(/\/login$/);
  await page.goto("/kiosk");
  await expect(page.locator(".kiosk-idle")).toBeVisible();
  await expect(home(page)).toHaveCount(0);
});

test("the idle screen still identifies a physical card scan", async ({ page }) => {
  await page.goto("/kiosk");
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await identifyStep(page).fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("你好，林知秋");
});

test("30 s without activity signs the reader out to the kiosk idle screen", async ({ page }) => {
  await page.clock.install();
  await readerLogin(page);
  await page.clock.runFor(1_000); // the card-reading animation on /login
  await expect(home(page)).toBeVisible();

  await page.clock.runFor(31_000);
  await expect(page.locator(".kiosk-idle")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/kiosk");
  const me = await page.evaluate(() => fetch("/api/auth/me").then((response) => response.json()));
  expect(me.user).toBeNull();
});
