import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertFull, MaintenanceRow, RuleRow } from "./adminApi";
import {
  alertsFor, axisDomain, bucketize, collectExport, deviceEventsFor, exportFilename, fetchTelemetrySeries, inRange,
  parseThresholds, placeFlagged, type TelemetrySample, type TraceLoan
} from "./insightApi";
import { buildXlsx, columnName, crc32, escapeXml, sheetName } from "./xlsx";

afterEach(() => vi.unstubAllGlobals());

const sample = (ts: string, value: number, quality: TelemetrySample["quality"] = "ok"): TelemetrySample => ({
  id: `${ts}-${value}`, device_id: "device-east-5", branch_id: "branch-east", metric: "temperature", value, quality, ts
});

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe("telemetry", () => {
  const from = Date.parse("2026-10-09T00:00:00Z");
  const hour = 3600_000;

  it("buckets clean samples into min/avg/max and sets flagged ones aside", () => {
    const { buckets, flagged } = bucketize([
      sample("2026-10-09T00:10:00Z", 20),
      sample("2026-10-09T00:50:00Z", 24),
      sample("2026-10-09T00:30:00Z", 999999, "dirty"),
      sample("2026-10-09T01:20:00Z", 30, "suspect"),
      sample("2026-10-09T05:00:00Z", 22)
    ], from, from + 2 * hour, hour);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ ts: "2026-10-09T00:00:00.000Z", avg: 22, min: 20, max: 24, count: 2 });
    expect(buckets[1]).toMatchObject({ avg: null, min: null, max: null, count: 0 });
    expect(flagged.map((item) => item.quality)).toEqual(["dirty", "suspect"]);
  });

  it("keeps a 999999 reading from flattening the axis and pins it to the top", () => {
    const { buckets, flagged } = bucketize([sample("2026-10-09T00:10:00Z", 20), sample("2026-10-09T00:20:00Z", 26), sample("2026-10-09T00:30:00Z", 999999, "dirty")], from, from + hour, hour);
    const domain = axisDomain({ buckets, flagged, samples: 3 }, { min: 10, max: 32 });
    expect(domain.min).toBeLessThanOrEqual(10);
    expect(domain.max).toBeGreaterThanOrEqual(32);
    expect(domain.max).toBeLessThan(40);
    expect(placeFlagged(flagged[0]!, domain)).toEqual({ y: domain.max, off: "above" });
    expect(placeFlagged(sample("2026-10-09T00:30:00Z", 25, "suspect"), domain)).toEqual({ y: 25, off: null });
  });

  it("reads thresholds from the alert_thresholds rule", () => {
    const rules = [{ key: "alert_thresholds", value_json: JSON.stringify({ temperature: { min: 10, max: 32 } }), description: "" }] as RuleRow[];
    expect(parseThresholds(rules).temperature).toEqual({ min: 10, max: 32 });
    expect(parseThresholds([{ key: "alert_thresholds", value_json: "{bad", description: "" }])).toEqual({});
  });

  it("falls back to windowed raw queries when the series route is missing, and reports capped windows", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith("/api/telemetry/series")) return json(404, {});
      const params = new URL(url, "http://x").searchParams;
      const start = Date.parse(params.get("from")!);
      // The first window is "busy": exactly the 1000-row cap.
      const rows = start === Date.parse("2026-10-08T00:00:00Z")
        ? Array.from({ length: 1000 }, (_, index) => sample(new Date(start + index * 1000).toISOString(), 21))
        : [sample(new Date(start + 60_000).toISOString(), 23)];
      return json(200, { data: rows });
    }));
    const series = await fetchTelemetrySeries("branch-east", "temperature", "24h", Date.parse("2026-10-09T00:00:00Z"));
    expect(calls.filter((url) => url.startsWith("/api/telemetry?"))).toHaveLength(24);
    expect(series.truncatedWindows).toBe(1);
    expect(series.samples).toBe(1000 + 23);
    expect(series.buckets).toHaveLength(48);
  });
});

describe("traceability", () => {
  const loan: TraceLoan = {
    id: "loan-00009", book_id: "book-0010", user_id: "reader-010", branch_id: "branch-east", device_id: "device-east-1",
    borrowed_at: "2026-09-01T10:00:00Z", due_at: "2026-10-01T10:00:00Z", returned_at: "2026-09-20T09:00:00Z", renew_count: 1, status: "returned"
  };
  const alert = (patch: Partial<AlertFull>): AlertFull => ({ id: "a", branch_id: "branch-east", type: "theft", severity: "warning", message: "m", status: "open", created_at: "2026-09-10T00:00:00Z", ...patch });

  it("derives device events from the loan and adds maintenance on its device during the loan", () => {
    const maintenance = [
      { id: "m1", device_id: "device-east-1", started_at: "2026-09-05T08:00:00Z", description: "Printer jam" },
      { id: "m2", device_id: "device-east-1", started_at: "2026-10-05T08:00:00Z", description: "After return" },
      { id: "m3", device_id: "device-east-2", started_at: "2026-09-05T08:00:00Z", description: "Other device" }
    ] as MaintenanceRow[];
    const events = deviceEventsFor(loan, maintenance, Date.parse("2026-10-09T00:00:00Z"));
    expect(events.map((event) => event.kind)).toEqual(["borrow", "maintenance", "return", "renew"]);
    expect(events.find((event) => event.kind === "renew")).toMatchObject({ approximate: true, detail: "×1" });
  });

  it("marks an unreturned loan past its due date as overdue", () => {
    const events = deviceEventsFor({ ...loan, returned_at: null, renew_count: 0, status: "active" }, [], Date.parse("2026-10-09T00:00:00Z"));
    expect(events.map((event) => event.kind)).toEqual(["borrow", "overdue"]);
  });

  it("collects alerts linked to the loan first, then device alerts inside the loan window", () => {
    const result = alertsFor(loan, [
      alert({ id: "late", device_id: "device-east-1", created_at: "2026-09-30T00:00:00Z" }),
      alert({ id: "linked", related_loan_id: "loan-00009", created_at: "2026-12-01T00:00:00Z" }),
      alert({ id: "inside", device_id: "device-east-1", created_at: "2026-09-02T00:00:00Z" }),
      alert({ id: "other", device_id: "device-east-3", created_at: "2026-09-02T00:00:00Z" })
    ]);
    expect(result.map((item) => [item.id, item.link])).toEqual([["linked", "loan"], ["inside", "device"]]);
  });
});

describe("exports", () => {
  it("filters by inclusive local day range", () => {
    expect(inRange("2026-10-01T10:00:00", "2026-10-01", "2026-10-01")).toBe(true);
    expect(inRange("2026-10-02T00:00:00", "2026-10-01", "2026-10-01")).toBe(false);
    expect(inRange(null, "2026-10-01", null)).toBe(false);
    expect(inRange(null, null, null)).toBe(true);
  });

  it("names files after dataset, branch, range and time", () => {
    const name = exportFilename({ dataset: "loans", branchId: "branch-east", from: "2026-09-01", to: "2026-09-30" }, "EAST", new Date("2026-10-10T08:05:00Z"));
    expect(name).toBe("ul_loans_EAST_2026-09-01_2026-09-30_20261010-0805.xlsx");
  });

  it("pages through a list endpoint, filters the range and keeps only the dataset columns", async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `loan-${index}`, borrowed_at: index < 10 ? "2026-10-05T10:00:00" : "2025-01-01T10:00:00", secret: "x", branch_id: "branch-east" }));
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, "http://x").searchParams;
      const offset = Number(params.get("offset"));
      return json(200, { data: rows.slice(offset, offset + Number(params.get("limit"))) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await collectExport({ dataset: "loans", branchId: "branch-east", from: "2026-10-01", to: "2026-10-10" }, []);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("branchId=branch-east");
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0]).not.toHaveProperty("secret");
    expect(result.rows[0]).toHaveProperty("renew_count", null);
  });
});

describe("xlsx", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("names columns and sheets the way Excel expects", () => {
    expect([0, 25, 26, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    const taken = new Set<string>();
    expect(sheetName("loans/2026:Q3", taken)).toBe("loans 2026 Q3");
    expect(sheetName("Loans 2026 Q3", taken)).toBe("Loans 2026 Q3 (2)");
    expect(escapeXml("a<b & \"c\"\u0001")).toBe("a&lt;b &amp; &quot;c&quot;");
  });

  it("writes a zip with the workbook parts, inline strings and numbers", () => {
    const bytes = buildXlsx([{ name: "loans", header: ["id", "renew_count"], rows: [["loan-1 <x>", 2], ["借阅", null]] }]);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(6);
    const text = new TextDecoder().decode(bytes);
    for (const part of ["[Content_Types].xml", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) expect(text).toContain(part);
    expect(text).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">loan-1 &lt;x&gt;</t></is></c><c r="B2"><v>2</v></c>');
    expect(text).toContain("借阅");
    expect(text).toContain('<autoFilter ref="A1:B3"/>');
  });
});
