// Masking for personal data that leaves the server in API responses, exports, and audit/log entries.

type Row = Record<string, unknown>;

export function maskTail(value: unknown, visible = 4) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const text = String(value);
  if (text.length <= visible) return "*".repeat(text.length);
  return "*".repeat(text.length - visible) + text.slice(-visible);
}

export function maskEmail(value: unknown) {
  if (value === null || value === undefined || value === "") return value ?? null;
  const [local = "", domain] = String(value).split("@");
  if (!domain) return maskTail(value);
  return `${local.slice(0, 1)}***@${domain}`;
}

// Login identifiers may be a username, an email, or a card number; only the latter two are personal data.
export function maskAccount(account: string) {
  if (account.includes("@")) return String(maskEmail(account));
  if (/^\d{6,}$/.test(account)) return String(maskTail(account));
  return account;
}

export function maskUser<T extends Row | undefined>(row: T): T {
  if (!row) return row;
  const { password_hash: _passwordHash, ...rest } = row;
  const masked: Row = { ...rest };
  if ("email" in masked) masked.email = maskEmail(masked.email);
  if ("card_no" in masked) masked.card_no = maskTail(masked.card_no);
  if ("student_no" in masked) masked.student_no = maskTail(masked.student_no);
  if ("qr_code" in masked) masked.qr_code = maskTail(masked.qr_code);
  return masked as T;
}
