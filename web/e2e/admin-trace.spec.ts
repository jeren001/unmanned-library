import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * /admin/trace: every input type the page offers ends in a trace chain, never in "数据载入失败",
 * and an input with no match shows the friendly "nothing found" state.
 * Uses the deterministic seed (loan-00009, RFID-000010 and book-0049 exist with full chains).
 */

test.use({ contextOptions: { reducedMotion: "reduce" } });

const steps = (page: Page) => page.locator(".admin-trace-step");
const loadError = (page: Page) => page.locator(".admin-error");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByRole("tab", { name: /Admin|管理员/ }).click();
  await page.locator('input[name="username"]').fill("admin");
  await page.locator('input[name="password"]').fill("admin123");
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/admin/);
}

async function traceFor(page: Page, text: string) {
  await page.goto("/admin/trace");
  await page.locator("#trace-q").fill(text);
  await page.locator(".admin-trace-search button[type=submit]").click();
}

/** The chain is on screen: book and RFID always; loan, device, clip, alerts and maintenance when the book has a loan. */
async function expectChain(page: Page, { full }: { full: boolean }) {
  await expect(steps(page).first()).toBeVisible();
  await expect(loadError(page)).toHaveCount(0);
  if (full) {
    await expect(steps(page)).toHaveCount(7);
    await expect(page.locator(".admin-trace-chain")).toContainText(/图书|Book/);
    await expect(page.locator(".admin-trace-chain")).toContainText(/RFID/);
    await expect(page.locator(".admin-trace-chain")).toContainText(/监控片段|Camera clip/);
    await expect(page.locator(".admin-trace-chain")).toContainText(/维护|Maintenance/);
  }
}

test.beforeEach(async ({ page }) => signIn(page));

test("a title lists matching books and each pick traces without an error", async ({ page }) => {
  await traceFor(page, "软件体系结构");
  const results = page.locator(".admin-trace-result");
  await expect(results.first()).toBeVisible();
  await results.first().click();
  await expectChain(page, { full: false });
});

test("a loan ID traces the full chain", async ({ page }) => {
  await traceFor(page, "loan-00009");
  await expectChain(page, { full: true });
  await expect(page.locator(".admin-trace-chain")).toContainText("loan-00009");
});

test("an RFID tag traces the full chain", async ({ page }) => {
  await traceFor(page, "RFID-000010");
  await expectChain(page, { full: true });
  await expect(page.locator(".admin-trace-tag")).toHaveText("RFID-000010");
});

test("an ISBN, by prefix or in full, traces without an error", async ({ page }) => {
  await traceFor(page, "978-7");
  const first = page.locator(".admin-trace-result").first();
  await expect(first).toBeVisible();
  const isbn = (await first.locator("code").innerText()).trim();
  await first.click();
  await expectChain(page, { full: false });

  await traceFor(page, isbn);
  await expectChain(page, { full: false });
  await expect(page.locator(".admin-trace-chain")).toContainText(isbn);
});

test("?book=book-0049 opens the full chain directly", async ({ page }) => {
  await page.goto("/admin/trace?book=book-0049");
  await expectChain(page, { full: true });
});

test("no match shows a friendly nothing-found state, not an error", async ({ page }) => {
  await traceFor(page, "没有这本书-xyz");
  await expect(page.getByText(/没有找到|Nothing found/)).toBeVisible();
  await expect(loadError(page)).toHaveCount(0);

  await page.goto("/admin/trace?book=book-9999");
  await expect(page.getByText(/没有找到|Nothing found/)).toBeVisible();
  await expect(loadError(page)).toHaveCount(0);

  await traceFor(page, "loan-99999");
  await expect(page.getByText(/没有找到|Nothing found/)).toBeVisible();
  await expect(loadError(page)).toHaveCount(0);
});
