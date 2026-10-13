import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, LIGHT_LUX_THRESHOLD } from "./database.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A database as it looked before migration 2, holding the given thresholds. */
function legacyDatabase(thresholds: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "library-db-"));
  dirs.push(dir);
  const file = join(dir, "library.sqlite");
  const db = createDatabase(file);
  db.prepare("INSERT INTO rules(key, value_json, description) VALUES ('alert_thresholds', ?, 'Telemetry thresholds')").run(JSON.stringify(thresholds));
  db.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
  db.close();
  return file;
}

const thresholdsIn = (file: string) => {
  const db = createDatabase(file);
  const row = db.prepare("SELECT value_json FROM rules WHERE key = 'alert_thresholds'").get() as { value_json: string };
  db.close();
  return JSON.parse(row.value_json) as Record<string, { min?: number; max?: number }>;
};

describe("migration 2: light_lux threshold", () => {
  it("moves the old default band to one that ignores normal indoor light", () => {
    const file = legacyDatabase({ temperature: { min: 10, max: 32 }, light_lux: { min: 80, max: 900 } });
    expect(thresholdsIn(file)).toEqual({ temperature: { min: 10, max: 32 }, light_lux: LIGHT_LUX_THRESHOLD });
  });

  it("leaves a threshold someone already changed alone", () => {
    const file = legacyDatabase({ light_lux: { min: 50, max: 900 } });
    expect(thresholdsIn(file).light_lux).toEqual({ min: 50, max: 900 });
  });
});
