import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import type { LibraryRepository } from "../persistence/repositories.js";
import { maskAccount, maskTail } from "../domain/privacy.js";

export type Role = "reader" | "librarian" | "admin";

type User = {
  id: string;
  role: Role;
  username: string;
  email?: string | null;
  display_name: string;
  card_no?: string | null;
  passwordHash: string;
  lockedUntil?: string | null;
};

type Session = {
  id: string;
  userId: string;
  expiresAt: number;
};

type AuditEntry = {
  at: string;
  event: "login" | "card-login" | "logout";
  /** Card sign-in only: typed card number plus PIN, or a card reader scan. */
  method?: "pin" | "scan";
  account: string;
  role?: Role;
  success: boolean;
  reason?: string;
  ip?: string;
};

const SESSION_COOKIE = "ul_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const LOCK_MS = 1000 * 60 * 10;
const RATE_WINDOW_MS = 1000 * 60;
const RATE_LIMIT = 12;
// Per-IP cap so rotating account or card numbers cannot bypass the per-account limit.
const IP_RATE_LIMIT = 30;

const loginSchema = z.object({
  role: z.enum(["reader", "librarian", "admin"]),
  account: z.string().trim().min(1),
  password: z.string().min(1),
  remember: z.boolean().optional()
});

const cardLoginSchema = z.object({
  cardNumber: z.string().trim().min(1),
  pin: z.string().min(1)
});

const cardScanSchema = z.object({
  cardNumber: z.string().trim().min(1)
});

/** The simulated card reader (POST /card-scan) exists only in demo mode: DEMO_MODE=true, on by default outside production. */
export function isServerDemoMode(env: NodeJS.ProcessEnv = process.env) {
  return env.DEMO_MODE ? env.DEMO_MODE === "true" : env.NODE_ENV !== "production";
}

const users = new Map<string, User>();
const sessions = new Map<string, Session>();
const failedAttempts = new Map<string, number>();
export const auditLog: AuditEntry[] = [];

function seedUsers() {
  if (users.size > 0) return;

  const demoUsers: Array<Omit<User, "passwordHash"> & { password: string }> = [
    { id: "reader-001", role: "reader", display_name: "林知秋", username: "R-2048", email: "reader.demo@library.local", card_no: "20240001", password: "reader123" },
    { id: "librarian-001", role: "librarian", display_name: "馆员值班台", username: "librarian", email: "librarian@library.local", password: "librarian123" },
    { id: "admin-001", role: "admin", display_name: "系统管理员", username: "admin", email: "admin@library.local", password: "admin123" }
  ];

  for (const user of demoUsers) {
    users.set(user.id, {
      ...user,
      passwordHash: bcrypt.hashSync(user.password, 10)
    });
  }
}

seedUsers();

function publicUser(user: User) {
  return {
    id: user.id,
    role: user.role,
    name: user.display_name,
    account: user.username,
    landingPath: user.role === "reader" ? "/kiosk" : "/admin"
  };
}

function mapRow(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    role: row.role as Role,
    username: String(row.username),
    email: row.email as string | null,
    display_name: String(row.display_name),
    card_no: row.card_no as string | null,
    passwordHash: String(row.password_hash),
    lockedUntil: row.locked_until as string | null
  };
}

function findUser(repo: LibraryRepository | undefined, role: Role, account: string) {
  if (repo) {
    const row = repo.findUserByAccount(account);
    if (row && row.role === role) {
      const user = mapRow(row);
      users.set(user.id, user);
      return user;
    }
    return undefined;
  }
  const normalized = account.toLowerCase();
  return [...users.values()].find((user) => user.role === role && [user.username, user.email, user.card_no].some((value) => value?.toLowerCase() === normalized));
}

function findUserByCard(repo: LibraryRepository | undefined, cardNumber: string) {
  if (repo) {
    const row = repo.findUserByAccount(cardNumber);
    if (row && row.role === "reader") {
      const user = mapRow(row);
      users.set(user.id, user);
      return user;
    }
    return undefined;
  }
  const normalized = cardNumber.toLowerCase();
  return [...users.values()].find((user) => user.role === "reader" && user.card_no?.toLowerCase() === normalized);
}

function audit(repo: LibraryRepository | undefined, entry: Omit<AuditEntry, "at">) {
  const row = { ...entry, account: maskAccount(entry.account), at: new Date().toISOString() };
  auditLog.push(row);
  if (repo) {
    repo.recordAudit({
      actor_id: null,
      action: entry.event,
      entity: "auth",
      entity_id: row.account,
      detail_json: JSON.stringify({ role: entry.role, success: entry.success, reason: entry.reason, method: entry.method }),
      ip: entry.ip,
      ts: row.at
    });
  }
}

function readCookie(req: Request, name: string) {
  const cookies = req.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

/** Session cookie flags: never readable from JS, not sent on cross-site POSTs, HTTPS-only in production. */
export function sessionCookieAttributes(env: string | undefined = process.env.NODE_ENV) {
  return `Path=/; HttpOnly; SameSite=Lax${env === "production" ? "; Secure" : ""}`;
}

function setSessionCookie(res: Response, sessionId: string, remember = false) {
  const maxAge = remember ? 60 * 60 * 24 * 14 : 60 * 60 * 8;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Max-Age=${maxAge}; ${sessionCookieAttributes()}`);
}

/** Expires the cookie with the same flags it was set with, so browsers replace it on log out. */
function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; ${sessionCookieAttributes()}`);
}

function createSession(user: User, remember = false) {
  const id = randomBytes(32).toString("base64url");
  users.set(user.id, user);
  sessions.set(id, {
    id,
    userId: user.id,
    expiresAt: Date.now() + (remember ? SESSION_TTL_MS * 42 : SESSION_TTL_MS)
  });
  return id;
}

function getSessionUser(req: Request) {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(sessionId);
    return undefined;
  }
  return users.get(session.userId);
}

function createRateLimiter() {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const hit = (key: string, limit: number, now: number) => {
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 10_000) for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
    const account = String(req.body?.account ?? req.body?.cardNumber ?? "auth").toLowerCase();
    const ipOk = hit(`ip:${req.ip}`, IP_RATE_LIMIT, now);
    const accountOk = hit(`account:${req.ip}:${account}`, RATE_LIMIT, now);
    if (!ipOk || !accountOk) {
      res.status(429).json({ error: "RATE_LIMITED", message: "Too many attempts. Please wait a minute." });
      return;
    }
    next();
  };
}

function safePasswordCompare(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

function safeCardCompare(input: string, stored: string) {
  const a = Buffer.from(input.toLowerCase());
  const b = Buffer.from(stored.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAuth(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = getSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    res.locals.user = publicUser(user);
    (req as Request & { user?: ReturnType<typeof publicUser> }).user = publicUser(user);
    next();
  };
}

export function createAuthRouter(repo?: LibraryRepository) {
const authRouter = Router();
const rateLimit = createRateLimiter();

authRouter.post("/login", rateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_INPUT" });
    return;
  }

  const { role, account, password, remember } = parsed.data;
  const user = findUser(repo, role, account);
  const ip = req.ip;
  if (!user) {
    audit(repo, { event: "login", account, role, success: false, reason: "unknown-account", ip });
    res.status(401).json({ code: "INVALID_CREDENTIALS", error: "INVALID_CREDENTIALS", message: "Account or password is incorrect." });
    return;
  }

  if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    audit(repo, { event: "login", account, role, success: false, reason: "locked", ip });
    res.status(423).json({ code: "ACCOUNT_LOCKED", error: "ACCOUNT_LOCKED", message: "Account is locked after 5 failed attempts." });
    return;
  }

  const ok = await safePasswordCompare(password, user.passwordHash);
  if (!ok) {
    const nextAttempts = (failedAttempts.get(user.id) ?? 0) + 1;
    failedAttempts.set(user.id, nextAttempts);
    const lockedUntil = nextAttempts >= 5 ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    if (lockedUntil && repo) repo.update("users", user.id, { locked_until: lockedUntil });
    audit(repo, { event: "login", account, role, success: false, reason: lockedUntil ? "locked" : "wrong-password", ip });
    res.status(lockedUntil ? 423 : 401).json({
      code: lockedUntil ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
      error: lockedUntil ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS",
      attemptsRemaining: Math.max(0, 5 - nextAttempts),
      message: lockedUntil ? "Account is locked after 5 failed attempts." : "Account or password is incorrect."
    });
    return;
  }

  failedAttempts.set(user.id, 0);
  if (repo) repo.update("users", user.id, { locked_until: null });
  const sessionId = createSession(user, remember);
  setSessionCookie(res, sessionId, remember);
  audit(repo, { event: "login", account, role, success: true, ip });
  res.json({ user: publicUser(user) });
});

// A typed card number is not proof of holding the card, so it needs the reader's PIN (their account password).
authRouter.post("/card-login", rateLimit, async (req, res) => {
  const parsed = cardLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_INPUT" });
    return;
  }

  const { cardNumber, pin } = parsed.data;
  const ip = req.ip;
  const user = findUserByCard(repo, cardNumber);
  const matchedCard = user?.card_no && safeCardCompare(cardNumber, user.card_no);
  // Unknown card and wrong PIN get the same answer, so the endpoint does not reveal which card numbers exist.
  const invalid = () => res.status(401).json({ code: "INVALID_CREDENTIALS", error: "INVALID_CREDENTIALS", message: "Card number or PIN is incorrect." });
  if (!user || !matchedCard) {
    audit(repo, { event: "card-login", method: "pin", account: String(maskTail(cardNumber)), role: "reader", success: false, reason: "unknown-card", ip });
    invalid();
    return;
  }

  if (user.lockedUntil && Date.parse(user.lockedUntil) > Date.now()) {
    audit(repo, { event: "card-login", method: "pin", account: user.username, role: "reader", success: false, reason: "locked", ip });
    res.status(423).json({ code: "ACCOUNT_LOCKED", error: "ACCOUNT_LOCKED", message: "Account is locked after 5 failed attempts." });
    return;
  }

  if (!(await safePasswordCompare(pin, user.passwordHash))) {
    const nextAttempts = (failedAttempts.get(user.id) ?? 0) + 1;
    failedAttempts.set(user.id, nextAttempts);
    const lockedUntil = nextAttempts >= 5 ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    if (lockedUntil && repo) repo.update("users", user.id, { locked_until: lockedUntil });
    audit(repo, { event: "card-login", method: "pin", account: user.username, role: "reader", success: false, reason: lockedUntil ? "locked" : "wrong-pin", ip });
    if (lockedUntil) res.status(423).json({ code: "ACCOUNT_LOCKED", error: "ACCOUNT_LOCKED", message: "Account is locked after 5 failed attempts." });
    else invalid();
    return;
  }

  failedAttempts.set(user.id, 0);
  if (repo) repo.update("users", user.id, { locked_until: null });
  const sessionId = createSession(user);
  setSessionCookie(res, sessionId);
  audit(repo, { event: "card-login", method: "pin", account: user.username, role: "reader", success: true, ip });
  res.json({ user: publicUser(user) });
});

// Lets /login show the demo accounts and the demo PIN only when the server is in demo mode (same flag as /card-scan).
authRouter.get("/demo", (_req, res) => {
  res.json({ demoMode: isServerDemoMode() });
});

// Simulates the physical card reader: holding the card is the proof, so no PIN. Demo mode only.
authRouter.post("/card-scan", (req, res, next) => {
  if (!isServerDemoMode()) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }
  next();
}, rateLimit, (req, res) => {
  const parsed = cardScanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "INVALID_INPUT" });
    return;
  }

  const user = findUserByCard(repo, parsed.data.cardNumber);
  const matchedCard = user?.card_no && safeCardCompare(parsed.data.cardNumber, user.card_no);
  if (!user || !matchedCard) {
    audit(repo, { event: "card-login", method: "scan", account: String(maskTail(parsed.data.cardNumber)), role: "reader", success: false, reason: "unknown-card", ip: req.ip });
    res.status(401).json({ code: "INVALID_CARD", error: "INVALID_CARD", message: "Reader card was not recognized." });
    return;
  }

  const sessionId = createSession(user);
  setSessionCookie(res, sessionId);
  audit(repo, { event: "card-login", method: "scan", account: user.username, role: "reader", success: true, ip: req.ip });
  res.json({ user: publicUser(user) });
});

authRouter.get("/me", (req, res) => {
  const user = getSessionUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

authRouter.post("/logout", (req, res) => {
  const sessionId = readCookie(req, SESSION_COOKIE);
  const user = getSessionUser(req);
  if (sessionId) sessions.delete(sessionId);
  clearSessionCookie(res);
  audit(repo, { event: "logout", account: user?.username ?? "anonymous", role: user?.role, success: true, ip: req.ip });
  res.status(204).end();
});

return authRouter;
}

export const authRouter = createAuthRouter();
