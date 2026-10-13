import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";

const screenshots = resolve("..", "docs/screenshots");

async function capture(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/kiosk-${name}.png`, fullPage: true });
}

async function login(page: Page) {
  await page.goto("/kiosk");
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
}

test("borrow, renew, return and offline outbox sync", async ({ page }) => {
  await login(page);
  await capture(page, "home");

  await page.getByRole("button", { name: /借阅.*Borrow/ }).click();
  await capture(page, "borrow");
  await page.getByPlaceholder("RFID-000001 / ISBN").fill("RFID-000001");
  await page.getByRole("button", { name: /添加.*Add/ }).click();
  await expect(page.locator(".kiosk-book-card").first()).toBeVisible();
  await page.getByRole("button", { name: /确认借阅.*Review/ }).click();
  await page.getByRole("button", { name: /借阅并开闸.*Borrow & exit/ }).click();
  await expect(page.getByText(/借阅成功|Borrowed/)).toBeVisible();
  await capture(page, "borrow-result");
  await page.getByRole("button", { name: /返回首页|Back to home/ }).click();

  await page.getByRole("button", { name: /续借.*Renew/ }).click();
  await capture(page, "renew");
  const renewal = page.locator(".kiosk-checkable").first();
  await renewal.locator("input").check();
  await page.getByRole("button", { name: /确认续借.*Renew selected/ }).click();
  await expect(page.getByText(/续借成功|Renewed/)).toBeVisible();
  await page.getByRole("button", { name: /返回首页|Back to home/ }).click();

  await page.getByRole("button", { name: /归还.*Return/ }).click();
  await capture(page, "return");
  await page.getByRole("button", { name: /归还.*Return/ }).last().click();
  await expect(page.getByText(/归还成功|Returned/)).toBeVisible();
  await page.getByRole("button", { name: /返回首页|Back to home/ }).click();

  await page.getByRole("link", { name: "登录页 / Login page" }).click({ delay: 950 });
  await page.getByRole("button", { name: /断开网络|Go offline/ }).click();
  await page.getByRole("button", { name: /借阅.*Borrow/ }).click();
  await page.getByPlaceholder("RFID-000001 / ISBN").fill("RFID-000002");
  await page.getByRole("button", { name: /添加.*Add/ }).click();
  await page.getByRole("button", { name: /确认借阅.*Review/ }).click();
  await page.getByRole("button", { name: /借阅并开闸.*Borrow & exit/ }).click();
  await expect(page.getByText(/已保存，网络恢复后自动提交|Saved for sync/)).toBeVisible();
  await expect(page.getByText(/已保存 1 笔操作|1 saved/)).toBeVisible();
  await capture(page, "offline-result");

  await page.getByRole("link", { name: "登录页 / Login page" }).click({ delay: 950 });
  await page.getByRole("button", { name: /恢复网络|Go online/ }).click();
  await expect(page.getByText(/已同步|Synced/)).toBeVisible({ timeout: 10_000 });
});
