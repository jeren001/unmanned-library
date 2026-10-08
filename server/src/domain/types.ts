export type Role = "reader" | "librarian" | "admin";
export type BookStatus = "on_shelf" | "borrowed" | "lost" | "repair";
export type LoanStatus = "active" | "returned" | "overdue" | "lost";

export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export const asString = (value: unknown) => String(value ?? "");
export const asNumber = (value: unknown) => Number(value ?? 0);
