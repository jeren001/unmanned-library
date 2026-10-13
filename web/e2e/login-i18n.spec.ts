import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/* Login messages follow the selected language, staff go straight to the console, readers get a short book opening. */

const alerts = (page: Page) => page.locator(".login-panel [role=alert]");

test("validation and server errors follow the selected UI language, also after switching", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("tab", { name: /馆员/ }).click();
  await page.locator('form button[type="submit"]').click();
  await expect(alerts(page)).toHaveText(["请输入工号或用户名。", "请输入密码。"]);

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(alerts(page)).toHaveText(["Enter your staff ID or username.", "Enter your password."]);

  await page.locator('input[name="username"]').fill("librarian");
  await page.locator('input[name="password"]').fill("not-the-password");
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator(".login-alert")).toContainText(/Sign-in failed.*Account or password is incorrect/s);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await expect(page.locator(".login-alert")).toContainText(/登录失败.*账号或密码不正确/s);

  await page.getByRole("tab", { name: /读者/ }).click();
  await page.getByLabel("读者证号").fill("");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await expect(alerts(page)).toHaveText(["请刷卡或输入读者证号。"]);
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(alerts(page)).toHaveText(["Scan or enter a reader card number."]);
});

for (const role of ["librarian", "admin"] as const) {
  test(`${role} goes straight to the console without an intermediate screen`, async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("tab", { name: role === "admin" ? /Admin/ : /Librarian/ }).click();
    await page.locator('input[name="username"]').fill(role);
    await page.locator('input[name="password"]').fill(`${role}123`);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/admin/);
    await expect(page.locator(".login-open")).toHaveCount(0);
    await expect(page.locator(".admin-sidebar")).toBeVisible();
  });
}

test("reader gets a ~1.2 s book opening with an Enter now button visible from the start", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Simulate scan" }).click();
  await expect(page.locator(".login-open")).toBeVisible();
  const opened = Date.now();
  const enter = page.getByRole("button", { name: "Enter now" });
  await expect(enter).toBeVisible();
  await expect(enter).toBeInViewport();
  await expect(page.locator(".login-open-hello")).toHaveText("Hello, Lin Zhiqiu");
  await page.waitForURL(/\/kiosk/, { timeout: 5_000 });
  expect(Date.now() - opened).toBeLessThan(2_000);
});

test("Enter now skips the reader transition", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: /模拟刷卡/ }).click();
  await expect(page.locator(".login-open-hello")).toHaveText("你好，林知秋");
  await page.getByRole("button", { name: "立即进入" }).click();
  await page.waitForURL(/\/kiosk/);
});
