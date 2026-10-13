import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * Clicks through every kiosk screen and every way out of it (Back, Home, "?", Cancel)
 * and checks that a screen is always rendered, never just the header.
 * Books are entered by RFID tag. The seed is deterministic; this east-branch book is on the shelf and is
 * not one that kiosk.spec.ts borrows, so the two specs can share a database.
 */

const BOOK_TAG = "RFID-000022";

test.use({ contextOptions: { reducedMotion: "reduce" } });

const screen = (page: Page) => page.locator("main.kiosk-page > section");
const back = (page: Page) => page.locator(".kiosk-nav-back");
const home = (page: Page) => page.locator(".kiosk-nav-home");
const helpButton = (page: Page) => page.getByRole("button", { name: "Help", exact: true });
const tile = (page: Page, name: RegExp) => page.locator(".kiosk-action-grid button").filter({ hasText: name });

/** Exactly one non-empty screen is on the page, plus the expected navigation buttons. */
async function expectScreen(page: Page, label: string, nav: { back: boolean; home: boolean }) {
  await expect(screen(page), `${label}: one screen rendered`).toHaveCount(1);
  await expect(screen(page), `${label}: screen visible`).toBeVisible();
  await expect(screen(page), `${label}: screen has content`).not.toHaveText(/^\s*$/);
  const box = await screen(page).boundingBox();
  expect(box?.height ?? 0, `${label}: screen has height`).toBeGreaterThan(120);
  await expect(back(page), `${label}: Back button`).toHaveCount(nav.back ? 1 : 0);
  await expect(home(page), `${label}: Home button`).toHaveCount(nav.home ? 1 : 0);
  if (nav.back) {
    const target = await back(page).boundingBox();
    expect(target?.height ?? 0, `${label}: Back is a 64px touch target`).toBeGreaterThanOrEqual(64);
    expect(target?.width ?? 0).toBeGreaterThanOrEqual(64);
  }
}

async function signIn(page: Page) {
  await page.goto("/kiosk");
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
}

async function placeBookAndReview(page: Page) {
  await page.getByPlaceholder("RFID-000001 / ISBN").fill(BOOK_TAG);
  await page.getByRole("button", { name: /添加.*Add/ }).click();
  await expect(page.locator(".kiosk-book-card").first()).toBeVisible();
  await page.getByRole("button", { name: /确认借阅.*Review/ }).click();
  await expect(page.getByText(/请确认以下借阅/)).toBeVisible();
}

test("guest screens: idle, identify and help always render and Back steps out", async ({ page }) => {
  await page.goto("/kiosk");
  await expect(page.locator(".kiosk-idle")).toBeVisible();
  await expectScreen(page, "idle", { back: false, home: false });

  await helpButton(page).click();
  await expect(page.locator(".kiosk-help")).toBeVisible();
  await expectScreen(page, "idle → help", { back: true, home: false });
  await expect(page.locator(".kiosk-help-art svg")).toHaveCount(3);
  await page.getByRole("button", { name: /呼叫远程支持/ }).click();
  await expect(page.locator(".kiosk-help-confirm")).toContainText(/已呼叫远程支持|请求已记录/);
  await expectScreen(page, "help → call support", { back: true, home: false });
  await back(page).click();
  await expect(page.locator(".kiosk-idle")).toBeVisible();
  await expectScreen(page, "help → Back", { back: false, home: false });

  await helpButton(page).click();
  await page.locator(".kiosk-back").click();
  await expectScreen(page, "help → top arrow", { back: false, home: false });

  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await expectScreen(page, "identify", { back: true, home: false });
  await helpButton(page).click();
  await expectScreen(page, "identify → help", { back: true, home: false });
  await back(page).click();
  await expect(page.getByLabel("Reader card number")).toBeVisible();
  await expectScreen(page, "identify → help → Back", { back: true, home: false });
  await back(page).click();
  await expect(page.locator(".kiosk-idle")).toBeVisible();
  await expectScreen(page, "identify → Back", { back: false, home: false });
});

test("reader screens: every flow, help and Back/Home keep a screen and the session", async ({ page }) => {
  await signIn(page);
  await expectScreen(page, "home", { back: false, home: false });

  const voice = page.getByRole("button", { name: "Voice on" });
  await voice.click();
  await expect(page.getByRole("button", { name: "Voice off" })).toBeVisible();

  for (const [name, pattern] of [
    ["borrow", /借阅.*Borrow/],
    ["return", /归还.*Return/],
    ["renew", /续借.*Renew/],
    ["reserve", /预约.*Reserve/],
    ["loans", /我的借阅.*My loans/],
    ["help", /帮助.*Help/]
  ] as const) {
    await tile(page, pattern).click();
    await expectScreen(page, name, { back: true, home: true });
    const title = (await page.locator(".kiosk-shell-heading h1").textContent()) ?? "";

    // "?" opens help; Back returns to the same screen. (On help itself "?" changes nothing.)
    if (name !== "help") {
      await helpButton(page).click();
      await expect(page.locator(".kiosk-help")).toBeVisible();
      await expectScreen(page, `${name} → help`, { back: true, home: true });
      await back(page).click();
      await expect(page.locator(".kiosk-shell-heading h1")).toHaveText(title);
      await expectScreen(page, `${name} → help → Back`, { back: true, home: true });
    }

    // The top arrow, the bottom Back and Home all land on a rendered home screen.
    await page.locator(".kiosk-back").click();
    await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
    await expectScreen(page, `${name} → top arrow`, { back: false, home: false });
    await tile(page, pattern).click();
    await back(page).click();
    await expectScreen(page, `${name} → Back`, { back: false, home: false });
    await tile(page, pattern).click();
    await home(page).click();
    await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
    await expectScreen(page, `${name} → Home`, { back: false, home: false });
  }

  // Borrow step by step: Back goes one step, help keeps the flow, Cancel leaves it.
  await tile(page, /借阅.*Borrow/).click();
  await placeBookAndReview(page);
  await expectScreen(page, "borrow step 2", { back: true, home: true });
  await helpButton(page).click();
  await back(page).click();
  await expect(page.getByText(/请确认以下借阅/)).toBeVisible();
  await back(page).click();
  await expect(page.getByText(/请将图书平放在感应区/)).toBeVisible();
  await expect(page.locator(".kiosk-book-card").first()).toBeVisible();
  await expectScreen(page, "borrow step 2 → Back", { back: true, home: true });
  await page.getByRole("button", { name: /确认借阅.*Review/ }).click();
  await page.getByRole("button", { name: /取消.*Cancel/ }).click();
  await expectScreen(page, "borrow step 2 → Cancel", { back: false, home: false });

  await tile(page, /借阅.*Borrow/).click();
  await page.getByRole("button", { name: /取消.*Cancel/ }).click();
  await expectScreen(page, "borrow step 1 → Cancel", { back: false, home: false });

  await tile(page, /借阅.*Borrow/).click();
  await placeBookAndReview(page);
  await page.getByRole("button", { name: /借阅并开闸.*Borrow & exit/ }).click();
  await expect(page.getByText(/借阅成功|Borrowed|已保存/).first()).toBeVisible();
  await expectScreen(page, "borrow step 3 (receipt)", { back: true, home: true });
  await helpButton(page).click();
  await back(page).click();
  await expectScreen(page, "receipt → help → Back", { back: true, home: true });
  await back(page).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  await expectScreen(page, "receipt → Back", { back: false, home: false });

  // Return the book just borrowed, covering the return result screen.
  await tile(page, /归还.*Return/).click();
  await page.locator(".kiosk-shell").getByRole("button", { name: /归还.*Return/ }).last().click();
  await expect(page.getByText(/归还成功|Returned|归还已保存/).first()).toBeVisible();
  await expectScreen(page, "return result", { back: true, home: true });
  await back(page).click();
  await expectScreen(page, "return result → Back", { back: false, home: false });

  // Home help: confirmation stays on the help screen.
  await tile(page, /帮助.*Help/).click();
  await page.getByRole("button", { name: /呼叫远程支持/ }).click();
  await expect(page.locator(".kiosk-help-confirm")).toContainText(/已呼叫远程支持|请求已记录/);
  await expectScreen(page, "help → call support", { back: true, home: true });
  await home(page).click();
  await expectScreen(page, "help → Home", { back: false, home: false });
});

test("unknown login and admin addresses show a 404 with a way back to /login", async ({ page }) => {
  for (const path of ["/login/nope", "/nowhere"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: /找不到这一页|Page not found/ })).toBeVisible();
  }
  await page.getByRole("link", { name: /返回登录页|Back to login/ }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole("tab", { name: /Admin|管理员/ }).click();
  await page.locator('input[name="username"]').fill("admin");
  await page.locator('input[name="password"]').fill("admin123");
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin/);
  await page.goto("/admin/nope");
  await expect(page.getByRole("heading", { name: /找不到这一页|Page not found/ })).toBeVisible();
  await expect(page.locator(".admin-sidebar")).toBeVisible();
  await page.getByRole("link", { name: /返回登录页|Back to login/ }).click();
  await expect(page).toHaveURL(/\/login$/);
});
