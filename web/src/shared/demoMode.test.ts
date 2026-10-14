import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDemoMode } from "./demoMode";

const envFile = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");

describe("demo mode", () => {
  it("is on only when VITE_DEMO_MODE is \"true\"", () => {
    expect(isDemoMode({ VITE_DEMO_MODE: "true" })).toBe(true);
    expect(isDemoMode({ VITE_DEMO_MODE: "false" })).toBe(false);
    expect(isDemoMode({ VITE_DEMO_MODE: "1" })).toBe(false);
    expect(isDemoMode({})).toBe(false);
  });

  it("is on for `npm run dev` and off for the production build", () => {
    expect(envFile(".env.development")).toMatch(/^VITE_DEMO_MODE=true$/m);
    expect(envFile(".env.production")).toMatch(/^VITE_DEMO_MODE=false$/m);
  });
});
