import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/* Kiosk home after sign-in: one greeting, catalogue search, four service tiles, My loans, one language. */

test.use({ contextOptions: { reducedMotion: "reduce" } });

// Seed data is deterministic; this east-branch book is on the shelf and no other spec borrows it.
const BOOK_TAG = "RFID-000019";
const home = (page: Page) => page.locator(".kiosk-catalog");
const CJK = /[一-鿿]/;

async function signIn(page: Page) {
  await page.goto("/kiosk");
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(home(page)).toBeVisible();
}

test("home renders the catalogue layout in one language", async ({ page }) => {
  await signIn(page);

  // One greeting with the name once, no second welcome line.
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("你好，林知秋");
  await expect(home(page).getByText("林知秋")).toHaveCount(1);
  await expect(home(page).getByText(/欢迎回来|Welcome back/)).toHaveCount(0);

  // Four service tiles in the concept's order and colours; Borrow is the largest.
  const tiles = home(page).locator("[data-service]");
  await expect(tiles).toHaveCount(4);
  expect(await tiles.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-service")))).toEqual(["borrow", "return", "renew", "reserve"]);
  const look = await tiles.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { background: getComputedStyle(element).backgroundColor, area: box.width * box.height };
  }));
  expect(look.map((tile) => tile.background)).toEqual(["rgb(142, 27, 46)", "rgb(244, 182, 176)", "rgb(255, 255, 255)", "rgb(163, 91, 51)"]);
  expect(look[0].area).toBeGreaterThan(Math.max(...look.slice(1).map((tile) => tile.area)));
  await expect(tiles.first()).toHaveCSS("opacity", "1");

  // Help lives in the header; the voice toggle is gone.
  await expect(page.getByRole("button", { name: "Help", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Voice/ })).toHaveCount(0);
  await expect(page.getByText(/^[声静]$/)).toHaveCount(0);

  // My loans panel.
  await expect(page.locator(".kiosk-my-loans")).toContainText("我的借阅");

  // Catalogue search uses the books API.
  const searched = page.waitForResponse((response) => response.url().includes("/api/books") && response.url().includes("q="));
  await page.getByRole("searchbox").fill("系统");
  expect((await searched).status()).toBe(200);
  await expect(page.locator(".kiosk-catalog-results li").first()).toBeVisible();
  await expect(page.locator(".kiosk-catalog-results li").first()).toContainText(/在架|已借出/);
  await page.getByRole("button", { name: "清除" }).click();
  await expect(page.locator(".kiosk-catalog-results")).toHaveCount(0);

  // The zh/EN switch changes everything on home to English, with no Chinese left behind.
  await page.locator(".kiosk-lang").getByRole("button", { name: "EN", exact: true }).click();
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("Hello, Lin Zhiqiu");
  await expect(tiles).toHaveText([/^Borrow/, /^Return/, /^Renew/, /^Reserve/]);
  for (const text of await tiles.allInnerTexts()) expect(text).not.toMatch(CJK);
  expect(await page.locator(".kiosk-my-loans-head, .kiosk-my-loans-stats").allInnerTexts()).not.toContainEqual(expect.stringMatching(CJK));
  await page.locator(".kiosk-lang").getByRole("button", { name: "中文", exact: true }).click();
  await expect(home(page).getByRole("heading", { level: 1 })).toHaveText("你好，林知秋");
});

test("my loans lists a new loan with a due badge and a counted total", async ({ page }) => {
  await signIn(page);
  const before = Number((await page.locator("#kiosk-my-loans-title").innerText()).replace(/\D/g, "") || 0);

  await page.locator("[data-service=borrow]").click();
  await page.getByPlaceholder("RFID-000001 / ISBN").fill(BOOK_TAG);
  await page.getByRole("button", { name: /添加.*Add/ }).click();
  await page.getByRole("button", { name: /确认借阅.*Review/ }).click();
  await page.getByRole("button", { name: /借阅并开闸.*Borrow & exit/ }).click();
  await expect(page.getByText(/借阅成功|Borrowed|已保存/).first()).toBeVisible();
  await page.locator(".kiosk-nav-home").click();

  await expect(page.locator("#kiosk-my-loans-title")).toContainText(String(before + 1));
  const row = page.locator(".kiosk-my-loans-list li").filter({ has: page.locator(".kiosk-due") }).first();
  await expect(row).toBeVisible();
  await expect(page.locator(".kiosk-my-loans-list .kiosk-due").first()).toHaveText(/天后到期|今天到期|已逾期/);

  // Put the book back so the seed stays reusable.
  await page.locator("[data-service=return]").click();
  await page.locator(".kiosk-shell").getByRole("button", { name: /归还.*Return/ }).last().click();
  await expect(page.getByText(/归还成功|Returned|归还已保存/).first()).toBeVisible();
});
