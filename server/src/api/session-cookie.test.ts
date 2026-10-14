import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { createServer } from "./server.js";
import { sessionCookieAttributes } from "./auth.js";
import type { LibraryRepository } from "../persistence/repositories.js";

process.env.SIMULATOR_ENABLED = "false";

/* The session cookie is httpOnly and sameSite=lax (secure in production), and log out clears it. */

let server: Server;
let app: ReturnType<typeof createServer>;
let base = "";

beforeAll(async () => {
  app = createServer(":memory:");
  (app.locals.persistence.repo as LibraryRepository).insert("users", { id: "admin-001", role: "admin", username: "admin", email: "admin@library.local", password_hash: bcrypt.hashSync("admin123", 4), display_name: "Admin", status: "active" });
  server = await new Promise<Server>((resolve) => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  app.locals.telemetryPipeline.stop();
  await app.locals.simulator.stop();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  app.locals.persistence.db.close();
});

describe("session cookie", () => {
  it("is HttpOnly and SameSite=Lax, and Secure only in production", () => {
    expect(sessionCookieAttributes("production")).toBe("Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(sessionCookieAttributes("development")).toBe("Path=/; HttpOnly; SameSite=Lax");
  });

  it("is set on login and cleared on log out", async () => {
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin", account: "admin", password: "admin123" }) });
    const issued = login.headers.get("set-cookie") ?? "";
    expect(issued).toMatch(/^ul_session=[^;]+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax$/);
    const cookie = issued.split(";")[0]!;

    const logout = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toBe("ul_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");

    // The old cookie no longer opens a session.
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    expect((await me.json() as { user: unknown }).user).toBeNull();
  });
});
