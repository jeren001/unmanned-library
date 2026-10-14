export type Role = "reader" | "librarian" | "admin";

export type SessionUser = {
  id: string;
  role: Role;
  name: string;
  account: string;
  landingPath?: string;
};

export class LoginError extends Error {
  constructor(public code: string, public attemptsRemaining?: number) {
    super(code);
  }
}

/** Where each role lands after signing in. */
export function destinationFor(role: Role) {
  return role === "reader" ? "/kiosk" : "/admin";
}

async function postLogin(path: string, body: unknown): Promise<SessionUser> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new LoginError("NETWORK");
  }
  const data = (await response.json().catch(() => ({}))) as { user?: SessionUser; code?: string; error?: string; attemptsRemaining?: number };
  if (!response.ok || !data.user) {
    const fallback = response.status === 423 ? "ACCOUNT_LOCKED" : response.status === 429 ? "RATE_LIMITED" : response.ok ? "UNKNOWN" : "INVALID_CREDENTIALS";
    throw new LoginError(data.code ?? data.error ?? fallback, data.attemptsRemaining);
  }
  return data.user;
}

export function passwordLogin(role: Role, account: string, password: string, remember: boolean) {
  return postLogin("/api/auth/login", { role, account: account.trim(), password, remember });
}

/** A typed card number needs the reader's PIN. */
export function cardLogin(cardNumber: string, pin: string) {
  return postLogin("/api/auth/card-login", { cardNumber: cardNumber.trim(), pin });
}

/** Simulated card reader (demo mode only): holding the card is the proof, so no PIN. */
export function cardScan(cardNumber: string) {
  return postLogin("/api/auth/card-scan", { cardNumber: cardNumber.trim() });
}

/** i18n key (+ interpolation values) for a failed login. */
export function loginErrorMessage(error: unknown): { key: string; values?: Record<string, number> } {
  const code = error instanceof LoginError ? error.code : "UNKNOWN";
  switch (code) {
    case "ACCOUNT_LOCKED":
      return { key: "login.error.locked" };
    case "RATE_LIMITED":
      return { key: "login.error.rateLimited" };
    case "INVALID_CARD":
      return { key: "login.error.invalidCard" };
    case "INVALID_INPUT":
      return { key: "login.error.invalidInput" };
    case "NETWORK":
      return { key: "login.error.network" };
    case "INVALID_CREDENTIALS": {
      const remaining = (error as LoginError).attemptsRemaining;
      return remaining === undefined ? { key: "login.error.invalidCredentials" } : { key: "login.error.attemptsLeft", values: { count: remaining } };
    }
    default:
      return { key: "login.error.unknown" };
  }
}

/** Card sign-in errors: a wrong card or PIN and the PIN lockout get their own wording. */
export function cardLoginErrorMessage(error: unknown): { key: string; values?: Record<string, number> } {
  const code = error instanceof LoginError ? error.code : "UNKNOWN";
  if (code === "INVALID_CREDENTIALS") return { key: "login.error.wrongPin" };
  if (code === "ACCOUNT_LOCKED") return { key: "login.error.pinLocked" };
  return loginErrorMessage(error);
}
