/*
 * Visual / a11y audit: screenshots of every page into docs/screenshots and a JSON report
 * (docs/screenshots/audit.json) of overflow, truncation, raw i18n keys, low contrast, focus
 * visibility, animations left running under prefers-reduced-motion, and kiosk frame times.
 *
 *   npx playwright test e2e/audit.spec.ts
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const shots = resolve("..", "docs/screenshots");
const report: Record<string, unknown> = {};
const DESKTOP = { width: 1440, height: 900 };
const KIOSK = { width: 1080, height: 1920 };
const WALLBOARD = { width: 1920, height: 1080 };

const ADMIN_PAGES = [
  ["overview", ""], ["books", "books"], ["readers", "readers"], ["circulation", "circulation"], ["devices", "devices"],
  ["alerts", "alerts"], ["maintenance", "maintenance"], ["telemetry", "telemetry?branch=branch-east&metric=temperature&range=30d"],
  ["trace", "trace?book=book-0010&loan=loan-00009"], ["exports", "exports"], ["rules", "settings/rules"], ["simulator", "settings/simulator"]
] as const;

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test.afterAll(async () => {
  // Next to the screenshots: Playwright empties test-results/ on every run.
  // Merge so a filtered run (-g) does not erase the other sections.
  const previous = await readFile(`${shots}/audit.json`, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => ({}));
  await mkdir(shots, { recursive: true });
  await writeFile(`${shots}/audit.json`, JSON.stringify({ ...previous, ...report }, null, 2));
});

/** Runs in the page: overflow, truncation, raw i18n keys, CJK leaks (en) and text contrast. */
function inspect(lang: "zh" | "en") {
  type RGBA = [number, number, number, number];
  const parse = (value: string): RGBA => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  };
  const lum = ([r, g, b]: RGBA) => {
    const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const blend = (top: RGBA, bottom: RGBA): RGBA => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const name = (el: Element) => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && parts.length < 3 && node !== document.body; node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase() + (node.classList.length ? `.${[...node.classList].slice(0, 2).join(".")}` : ""));
    }
    return parts.join(" > ");
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
    }
    return !el.closest(".qa-sr-only,[aria-hidden='true'],canvas,svg");
  };
  /** Background under an element; null when it sits on an image/gradient we cannot resolve. */
  const background = (el: Element): RGBA | null => {
    const stack: RGBA[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.backgroundImage !== "none" && !s.backgroundImage.startsWith("url(")) return null;
      const color = parse(s.backgroundColor);
      if (color[3] > 0) { stack.push(color); if (color[3] >= 1) break; }
    }
    let result: RGBA = [255, 255, 255, 1];
    for (let index = stack.length - 1; index >= 0; index -= 1) result = blend(stack[index]!, result);
    return result;
  };

  const out = { pageOverflow: 0, truncated: [] as string[], keys: [] as string[], cjk: [] as string[], contrast: [] as string[] };
  if (document.documentElement.scrollWidth > innerWidth + 1) out.pageOverflow = document.documentElement.scrollWidth;

  const seen = new Set<Element>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const value = text.textContent?.trim() ?? "";
    const el = text.parentElement;
    if (!value || !el || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    if (/^(admin|kiosk|login|catalog|book|theme|lang|state|table|route|design)\.[\w.]+$/.test(value)) out.keys.push(`${name(el)} "${value}"`);
    if (lang === "en" && /[一-鿿]/.test(value) && !el.closest("[lang='zh-CN'],[data-allow-zh]")) out.cjk.push(`${name(el)} "${value.slice(0, 40)}"`);

    const s = getComputedStyle(el);
    // Ellipsis or clipped single line / line clamp.
    if ((s.textOverflow === "ellipsis" || s.overflow === "hidden" || s.overflowX === "hidden") && el.scrollWidth > el.clientWidth + 1) out.truncated.push(`${name(el)} "${value.slice(0, 40)}"`);
    else if (s.webkitLineClamp !== "none" && s.webkitLineClamp && el.scrollHeight > el.clientHeight + 1) out.truncated.push(`${name(el)} (clamp) "${value.slice(0, 40)}"`);

    if (el.closest("[disabled],[aria-disabled='true'],.qa-skeleton")) continue;
    const bg = background(el);
    if (!bg) continue;
    let fg = parse(s.color);
    let opacity = 1;
    for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    fg = blend([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1! + 0.05) / (l2! + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) out.contrast.push(`${ratio.toFixed(2)} ${name(el)} "${value.slice(0, 30)}"`);
  }
  out.truncated = [...new Set(out.truncated)].slice(0, 30);
  out.contrast = [...new Set(out.contrast)].slice(0, 40);
  return out;
}

/** Tabs through the page and records stops without a visible focus indicator. */
async function focusAudit(page: Page, stops = 60) {
  await page.locator("body").click({ position: { x: 1, y: 1 }, force: true }).catch(() => undefined);
  const missing = new Set<string>();
  const order: string[] = [];
  for (let index = 0; index < stops; index += 1) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none";
      const label = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.split(" ").slice(0, 2).join(".")}` : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`;
      return { label, ring };
    });
    if (!result) continue;
    order.push(result.label);
    if (!result.ring) missing.add(result.label);
  }
  // Pointer-only controls: look clickable but cannot be reached with the keyboard.
  const mouseOnly = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => {
    if (getComputedStyle(el).cursor !== "pointer") return false;
    if (el.closest("a[href],button,input,select,textarea,summary,label,[tabindex]")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).slice(0, 10).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`));
  return { missing: [...missing], mouseOnly, stops: order.length };
}

async function runningAnimations(page: Page) {
  return page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").map((animation) => {
    const effect = animation.effect as KeyframeEffect | null;
    const target = effect?.target as Element | null;
    const name = (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? "waapi";
    return `${name} on ${target ? `${target.tagName.toLowerCase()}.${[...target.classList].join(".")}` : "?"} (${String(effect?.getTiming().iterations)}x ${String(effect?.getTiming().duration)})`;
  }));
}

async function settle(page: Page, ms = 900) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function audit(page: Page, key: string, options: { lang?: "zh" | "en"; focus?: boolean; shot?: boolean } = {}) {
  const entry: Record<string, unknown> = await page.evaluate(inspect, options.lang ?? "zh");
  if (options.shot !== false) {
    // Grow the viewport to the page height so sticky/100vh chrome (sidebar, top bar) renders
    // as it does on screen instead of mid-page in a stitched full-page capture.
    const size = page.viewportSize()!;
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > size.height) { await page.setViewportSize({ width: size.width, height: Math.min(height, 8000) }); await page.waitForTimeout(300); }
    await page.screenshot({ path: `${shots}/${key}.png` });
    await page.setViewportSize(size);
  }
  if (options.focus) entry.focus = await focusAudit(page);
  report[key] = entry;
}

async function adminContext(browser: Browser, theme: "light" | "dark", reducedMotion: "reduce" | "no-preference" = "no-preference", viewport = DESKTOP) {
  const context = await browser.newContext({ viewport, reducedMotion });
  await context.addInitScript((value) => { try { localStorage.setItem("ul-admin-theme", value); localStorage.setItem("ul-login-theme", value); } catch { /* ignore */ } }, theme);
  const response = await context.request.post("/api/auth/login", { data: { role: "admin", account: "admin", password: "admin123" } });
  expect(response.ok()).toBeTruthy();
  return context;
}

test("login and design system", async ({ browser }) => {
  await mkdir(shots, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: DESKTOP });
    await context.addInitScript((value) => { try { localStorage.setItem("ul-login-theme", value); } catch { /* ignore */ } }, theme);
    const page = await context.newPage();
    await page.goto("/login");
    await settle(page, 2500);
    await audit(page, `login-${theme}`, { focus: theme === "light" });
    await page.goto("/design");
    await settle(page);
    if (theme === "dark") await page.getByRole("button", { name: /dark|深色/i }).first().click().catch(() => undefined);
    await settle(page, 400);
    await audit(page, `design-${theme}`, { focus: theme === "light" });
    await context.close();
  }
});

test("admin pages, light and dark", async ({ browser }) => {
  for (const theme of ["light", "dark"] as const) {
    const context = await adminContext(browser, theme);
    const page = await context.newPage();
    for (const [name, path] of ADMIN_PAGES) {
      await page.goto(`/admin/${path}`);
      await settle(page, name === "telemetry" || name === "trace" ? 2500 : 1200);
      if (name === "exports") {
        await page.getByRole("button", { name: /预览|Preview/ }).click();
        await settle(page, 1500);
      }
      await audit(page, `admin-${name}-${theme}`, { focus: theme === "light" });
    }
    await context.close();
  }
});

test("admin pages in English (untranslated strings)", async ({ browser }) => {
  const context = await adminContext(browser, "light");
  const page = await context.newPage();
  await page.goto("/admin");
  await settle(page);
  await page.getByRole("button", { name: "EN", exact: true }).first().click();
  for (const [name, path] of ADMIN_PAGES) {
    // Client-side navigation keeps the in-memory language.
    await page.evaluate((target) => { window.history.pushState({}, "", target); window.dispatchEvent(new PopStateEvent("popstate")); }, `/admin/${path}`);
    await settle(page, name === "telemetry" || name === "trace" ? 2500 : 1000);
    await audit(page, `en-admin-${name}`, { lang: "en", shot: false });
  }
  await context.close();
});

test("wallboard 1920x1080", async ({ browser }) => {
  const context = await adminContext(browser, "dark", "no-preference", WALLBOARD);
  const page = await context.newPage();
  await page.goto("/admin/wallboard");
  await settle(page, 3000);
  await audit(page, "wallboard", { focus: true });
  await context.close();
});

async function kioskLogin(page: Page) {
  await page.goto("/kiosk");
  await settle(page, 1200);
  await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click();
  await settle(page, 500);
}

test("kiosk 1080x1920", async ({ browser }) => {
  const context = await browser.newContext({ viewport: KIOSK, hasTouch: false });
  // The audit pauses longer than the kiosk's 30 s inactivity logout; keep the session alive.
  await context.addInitScript(() => { window.setInterval(() => window.dispatchEvent(new Event("mousemove")), 5000); });
  const page = await context.newPage();
  await page.goto("/kiosk");
  await settle(page, 1500);
  await audit(page, "kiosk-idle", { focus: true });
  await kioskLogin(page);
  await audit(page, "kiosk-identify");
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await expect(page.getByRole("heading", { name: /欢迎回来/ })).toBeVisible();
  await settle(page);
  await audit(page, "kiosk-home", { focus: true });
  const screens: Array<[string, RegExp]> = [["borrow", /借阅.*Borrow/], ["return", /归还.*Return/], ["renew", /续借.*Renew/], ["reserve", /预约.*Reserve/], ["loans", /我的借阅.*My loans/]];
  for (const [name, button] of screens) {
    await page.getByRole("button", { name: button }).first().click();
    await settle(page);
    await audit(page, `kiosk-${name}`, { focus: name === "borrow" });
    await page.getByRole("button", { name: "返回 / Back" }).click();
    await settle(page, 500);
  }
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await settle(page);
  await audit(page, "kiosk-help");
  await context.close();
});

test("prefers-reduced-motion leaves no decorative animation running", async ({ browser }) => {
  const result: Record<string, string[]> = {};
  const kiosk = await browser.newContext({ viewport: KIOSK, reducedMotion: "reduce" });
  let page = await kiosk.newPage();
  await page.goto("/kiosk");
  await settle(page, 2000);
  result.kioskIdle = await runningAnimations(page);
  await kioskLogin(page);
  await page.getByLabel("Reader card number").fill("20240001");
  await page.getByRole("button", { name: /继续|Continue/ }).click();
  await settle(page, 1500);
  result.kioskHome = await runningAnimations(page);
  await page.getByRole("button", { name: /借阅.*Borrow/ }).first().click();
  await settle(page, 1500);
  result.kioskBorrow = await runningAnimations(page);
  await kiosk.close();

  const login = await browser.newContext({ viewport: DESKTOP, reducedMotion: "reduce" });
  page = await login.newPage();
  await page.goto("/login");
  await settle(page, 2500);
  result.login = await runningAnimations(page);
  await login.close();

  const admin = await adminContext(browser, "light", "reduce");
  page = await admin.newPage();
  for (const [name, path] of ADMIN_PAGES) {
    await page.goto(`/admin/${path}`);
    await settle(page, 1500);
    result[`admin-${name}`] = await runningAnimations(page);
  }
  await admin.close();
  const wall = await adminContext(browser, "dark", "reduce", WALLBOARD);
  page = await wall.newPage();
  await page.goto("/admin/wallboard");
  await settle(page, 3000);
  result.wallboard = await runningAnimations(page);
  await wall.close();
  report.reducedMotion = result;
});

/** Frame timing via rAF while a scenario runs, with the CPU throttled 4x (kiosk-class hardware). */
test("kiosk frame rate", async ({ browser }) => {
  const context = await browser.newContext({ viewport: KIOSK });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const frames: Record<string, unknown> = {};
  const measure = async (name: string, action: () => Promise<void>, ms = 3000) => {
    await page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const tick = (now: number) => { w.__frames.push(now - last); last = now; if (!w.__stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await action();
    await page.waitForTimeout(ms);
    const deltas = await page.evaluate(() => { const w = window as unknown as { __frames: number[]; __stop: boolean }; w.__stop = true; return w.__frames.slice(1); });
    const sorted = [...deltas].sort((a, b) => a - b);
    const total = deltas.reduce((sum, value) => sum + value, 0);
    frames[name] = {
      fps: Number((deltas.length / (total / 1000)).toFixed(1)),
      p95: Number((sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1)),
      worst: Number((sorted[sorted.length - 1] ?? 0).toFixed(1)),
      over20ms: deltas.filter((value) => value > 20).length,
      frames: deltas.length
    };
  };
  await page.goto("/kiosk");
  await settle(page, 1500);
  await measure("idle", async () => undefined, 4000);
  await measure("identify", async () => { await page.getByRole("button", { name: /请刷读者证|Tap your card/ }).click(); });
  await measure("home", async () => {
    await page.getByLabel("Reader card number").fill("20240001");
    await page.getByRole("button", { name: /继续|Continue/ }).click();
  });
  await measure("borrow", async () => { await page.getByRole("button", { name: /借阅.*Borrow/ }).first().click(); });
  await measure("add-book", async () => {
    await page.getByPlaceholder("RFID-000001 / ISBN").fill("RFID-000003");
    await page.getByRole("button", { name: /添加.*Add/ }).click();
  });
  await measure("back-home", async () => { await page.getByRole("button", { name: "返回 / Back" }).click(); });
  report.kioskFrames = frames;
  await context.close();
});
