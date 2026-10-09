import { describe, expect, it } from "vitest";
import { parseShelfLocation, shelfRoute } from "./ShelfRouteMap";

describe("parseShelfLocation", () => {
  it("reads the seeded branch-zone-number format", () => {
    expect(parseShelfLocation("EAST-C-17")).toEqual({ zone: "C", zoneIndex: 2, shelf: 17, bay: 2 });
  });

  it("reads the short zone-row-level format", () => {
    expect(parseShelfLocation("A-3-2")).toMatchObject({ zone: "A", shelf: 2, bay: 0 });
  });

  it("caps high shelf numbers to the last bay and rejects unknown zones", () => {
    expect(parseShelfLocation("north-h-40")?.bay).toBe(4);
    expect(parseShelfLocation("Z-1")).toBeNull();
    expect(parseShelfLocation(undefined)).toBeNull();
  });
});

describe("shelfRoute", () => {
  it("goes straight along the main aisle for the front row", () => {
    expect(shelfRoute({ zone: "E", zoneIndex: 4, shelf: 1, bay: 0 })).toBe("M24 214 L24 170 L34.4 170 L34.4 136");
  });

  it("turns up a side aisle into the middle aisle for the back row", () => {
    const route = shelfRoute({ zone: "B", zoneIndex: 1, shelf: 17, bay: 2 });
    expect(route).toBe("M24 214 L24 170 L100 170 L100 79 L140 79 L140 60");
  });
});
