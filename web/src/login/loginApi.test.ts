import { afterEach, describe, expect, it, vi } from "vitest";
import { cardLogin, cardLoginErrorMessage, cardScan, destinationFor, fetchServerDemoMode, LoginError, loginErrorMessage, passwordLogin } from "./loginApi";

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("login api", () => {
  it("shows the demo hints only when the server says it is in demo mode", async () => {
    mockFetch(200, { demoMode: true });
    await expect(fetchServerDemoMode()).resolves.toBe(true);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("/api/auth/demo");
    mockFetch(200, { demoMode: false });
    await expect(fetchServerDemoMode()).resolves.toBe(false);
    mockFetch(404, { error: "NOT_FOUND" });
    await expect(fetchServerDemoMode()).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(fetchServerDemoMode()).resolves.toBe(false);
  });

  it("returns the session user on success", async () => {
    mockFetch(200, { user: { id: "reader-001", role: "reader", name: "林知秋", account: "R-2048" } });
    await expect(cardLogin(" 20240001 ", "reader123")).resolves.toMatchObject({ name: "林知秋" });
    expect(JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)).toEqual({ cardNumber: "20240001", pin: "reader123" });
  });

  it("scans a card without a PIN on the card reader endpoint", async () => {
    mockFetch(200, { user: { id: "reader-001", role: "reader", name: "林知秋", account: "R-2048" } });
    await cardScan(" 20240001 ");
    const [path, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toBe("/api/auth/card-scan");
    expect(JSON.parse(init.body)).toEqual({ cardNumber: "20240001" });
  });

  it("maps a wrong card or PIN and the PIN lockout", async () => {
    mockFetch(401, { code: "INVALID_CREDENTIALS" });
    expect(cardLoginErrorMessage(await cardLogin("20240001", "x").catch((caught) => caught)).key).toBe("login.error.wrongPin");
    mockFetch(423, { code: "ACCOUNT_LOCKED" });
    expect(cardLoginErrorMessage(await cardLogin("20240001", "x").catch((caught) => caught)).key).toBe("login.error.pinLocked");
  });

  it("maps a wrong password with remaining attempts", async () => {
    mockFetch(401, { code: "INVALID_CREDENTIALS", attemptsRemaining: 3 });
    const error = await passwordLogin("admin", "admin", "x", false).catch((caught) => caught);
    expect(loginErrorMessage(error)).toEqual({ key: "login.error.attemptsLeft", values: { count: 3 } });
  });

  it("maps lockout even without a code in the body", async () => {
    mockFetch(423, {});
    const error = await passwordLogin("librarian", "librarian", "x", false).catch((caught) => caught);
    expect(loginErrorMessage(error).key).toBe("login.error.locked");
  });

  it("maps network failures and unknown cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(loginErrorMessage(await cardLogin("1", "0000").catch((caught) => caught)).key).toBe("login.error.network");
    expect(loginErrorMessage(new LoginError("INVALID_CARD")).key).toBe("login.error.invalidCard");
  });

  it("sends readers to the kiosk and staff to admin", () => {
    expect(destinationFor("reader")).toBe("/kiosk");
    expect(destinationFor("librarian")).toBe("/admin");
    expect(destinationFor("admin")).toBe("/admin");
  });
});
