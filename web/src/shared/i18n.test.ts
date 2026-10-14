import { afterEach, describe, expect, it, vi } from "vitest";

describe("locales", () => {
  it("zh-CN and en define exactly the same keys", async () => {
    const { resources } = await import("./i18n");
    const zh = Object.keys(resources["zh-CN"].translation).sort();
    const en = Object.keys(resources.en.translation).sort();
    expect(zh.filter((key) => !en.includes(key)), "keys missing in en").toEqual([]);
    expect(en.filter((key) => !zh.includes(key)), "keys missing in zh-CN").toEqual([]);
  });

  it("formats dates and numbers in the selected language", async () => {
    const { default: i18n, formatDate, formatNumber } = await import("./i18n");
    await i18n.changeLanguage("zh-CN");
    expect(formatDate("2026-11-13T12:00:00Z")).toBe("11月13日");
    await i18n.changeLanguage("en");
    expect(formatDate("2026-11-13T12:00:00Z")).toBe("Nov 13");
    expect(formatNumber(12345)).toBe("12,345");
    await i18n.changeLanguage("zh-CN");
  });
});

describe("language memory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
  }

  it("starts in the remembered language and saves every switch", async () => {
    const storage = memoryStorage({ "ul-lang": "en" });
    vi.stubGlobal("localStorage", storage);
    vi.resetModules();
    const { default: i18n, LANGUAGE_KEY } = await import("./i18n");
    expect(i18n.language).toBe("en");
    await i18n.changeLanguage("zh-CN");
    expect(storage.values.get(LANGUAGE_KEY)).toBe("zh-CN");
  });

  it("falls back to zh-CN when nothing (or something unknown) is stored", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "ul-lang": "fr" }));
    vi.resetModules();
    const { default: i18n } = await import("./i18n");
    expect(i18n.language).toBe("zh-CN");
  });
});
