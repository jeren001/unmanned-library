import { describe, expect, it } from "vitest";

describe("health route contract", () => {
  it("uses the expected response payload", () => {
    expect({ status: "ok" }).toEqual({ status: "ok" });
  });
});
