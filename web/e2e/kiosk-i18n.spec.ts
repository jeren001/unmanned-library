import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/*
 * Kiosk operation screens show one language at a time: in EN no Chinese characters remain, in 中文 no English
 * sentences remain. Book titles and author names are data, so they are left out of the comparison.
 */

test.use({ contextOptions: { reducedMotion: "reduce" } });

// Seed data is deterministic; this east-branch book is on the shelf and no other spec borrows it.
const BOOK_TAG = "RFID-000025";
const CJK = /[　-〿一-鿿＀-￯]/;
/** Two English words in a row; single tokens such as RFID, ISBN or the "UL" logo are fine in Chinese. */
const ENGLISH_SENTENCE = /[A-Za-z]{2,}[ ,.'’-]+[A-Za-z]{2,}/;

let catalogue: string[] = [];

async function visibleText(page: Page) {
  // The language switch always shows both "中文" and "EN"; everything else must follow the selection.
  return page.evaluate(() => {
    const lang = document.querySelector<HTMLElement>(".kiosk-lang");
    if (lang) lang.style.display = "none";
    const text = document.querySelector<HTMLElement>(".kiosk-page")!.innerText;
    if (lang) lang.style.display = "";
    return text;
  });
}

function withoutBookData(text: string) {
  return catalogue.reduce((rest, value) => rest.split(value).join(" "), text);
}

async function switchTo(page: Page, language: "EN" | "中文") {
  await page.locator(".kiosk-lang").getByRole("button", { name: language, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", language === "EN" ? "en" : "zh-CN");
}

/** Checks the current screen in both languages and leaves it in Chinese. */
async function expectOneLanguage(page: Page, screen: string) {
  await switchTo(page, "EN");
  const english = withoutBookData(await visibleText(page)).split("\n").filter((line) => CJK.test(line));
  expect(english, `${screen} (EN) shows Chinese`).toEqual([]);

  await switchTo(page, "中文");
  const chinese = withoutBookData(await visibleText(page)).split("\n").filter((line) => ENGLISH_SENTENCE.test(line));
  expect(chinese, `${screen} (中文) shows English`).toEqual([]);
}

test("borrow, return, renew, reserve and my loans follow the selected language", async ({ page }) => {
  await page.goto("/kiosk");
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(page.locator(".kiosk-catalog")).toBeVisible();

  // Every title and author in the catalogue, longest first so a title is removed before any part of it.
  const books = (await page.evaluate(async () => {
    const pages = await Promise.all([0, 200].map((offset) => fetch(`/api/books?limit=200&offset=${offset}`).then((response) => response.json())));
    return pages.flatMap((body: { data: Array<{ title: string; author: string }> }) => body.data);
  }));
  // The tray spine shows the first six characters of a title.
  catalogue = [...new Set(books.flatMap((book) => [book.title, book.title.slice(0, 6), book.author]))].sort((a, b) => b.length - a.length);
  expect(catalogue.length).toBeGreaterThan(10);

  // Borrow: scan step, a "not found" error, a placed book, the review step and the receipt.
  await page.locator("[data-service=borrow]").click();
  await expectOneLanguage(page, "borrow");
  const tagInput = page.getByPlaceholder(/^RFID-000001 (或|or) ISBN$/);
  await tagInput.fill("RFID-999999");
  await page.getByRole("button", { name: /^(添加|Add)$/ }).click();
  await expect(page.locator(".kiosk-error-card")).toBeVisible();
  await expectOneLanguage(page, "borrow error");
  await tagInput.fill(BOOK_TAG);
  await page.getByRole("button", { name: /^(添加|Add)$/ }).click();
  await expect(page.locator(".kiosk-book-card")).toHaveCount(1);
  await expectOneLanguage(page, "borrow with a book");
  await page.getByRole("button", { name: /^(确认借阅|Review)$/ }).click();
  await expect(page.locator(".kiosk-borrow-cards")).toBeVisible();
  await expectOneLanguage(page, "borrow review");
  await page.getByRole("button", { name: /^(借阅并开闸|Borrow & exit)$/ }).click();
  await expect(page.locator(".kiosk-borrow-summary h1")).toHaveText(/借阅成功|已保存/);
  await expectOneLanguage(page, "borrow receipt");
  await page.locator(".kiosk-nav-home").click();

  // Renew, including the "select a book first" error.
  await page.locator("[data-service=renew]").click();
  await expect(page.locator(".kiosk-renew-row").first()).toBeVisible();
  await page.getByRole("button", { name: /^(确认续借|Renew selected)$/ }).click();
  await expect(page.locator(".kiosk-error-card")).toBeVisible();
  await expectOneLanguage(page, "renew");
  await page.locator(".kiosk-nav-home").click();

  // Reserve: the empty start, a book that is on loan, and a search where everything is on the shelf.
  await page.locator("[data-service=reserve]").click();
  await expectOneLanguage(page, "reserve (empty)");
  const search = page.getByPlaceholder(/书名、拼音或 ISBN|Title, pinyin or ISBN/);
  await search.fill(BOOK_TAG);
  await page.getByRole("button", { name: /^(搜索|Search)$/ }).click();
  await expect(page.locator(".kiosk-reserve-grid .qa-catalog-card").first()).toBeVisible();
  await expectOneLanguage(page, "reserve (results)");
  await search.fill("RFID-000028");
  await page.getByRole("button", { name: /^(搜索|Search)$/ }).click();
  await expect(page.locator(".kiosk-flow-empty")).toBeVisible();
  await expectOneLanguage(page, "reserve (all on shelf)");
  await page.locator(".kiosk-nav-home").click();

  // My loans.
  await page.locator(".kiosk-my-loans-head button").click();
  await expect(page.locator(".kiosk-loans-summary")).toBeVisible();
  await expectOneLanguage(page, "my loans");
  await page.locator(".kiosk-nav-home").click();

  // Return: the loan list, a "no matching loan" error, then the result. This also puts the book back.
  await page.locator("[data-service=return]").click();
  await expect(page.locator(".kiosk-loan-row").first()).toBeVisible();
  await page.getByPlaceholder(/^RFID-000001 (或|or) ISBN$/).fill("RFID-999999");
  await page.getByRole("button", { name: /^(查找|Find)$/ }).click();
  await expect(page.locator(".kiosk-error-card")).toBeVisible();
  await expectOneLanguage(page, "return");
  await page.getByPlaceholder(/^RFID-000001 (或|or) ISBN$/).fill(BOOK_TAG);
  await page.getByRole("button", { name: /^(查找|Find)$/ }).click();
  await expect(page.locator(".kiosk-return-summary h1")).toHaveText(/归还成功|归还已保存/);
  await expectOneLanguage(page, "return result");
});
