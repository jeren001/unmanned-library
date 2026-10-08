import { randomUUID } from "node:crypto";
import type { LibraryRepository } from "../persistence/repositories.js";
import type { EventBus } from "../events/bus.js";
import { assertBookTransition } from "./bookState.js";
import { LoanPolicy } from "./loanPolicy.js";
import { asNumber, asString, DomainError, type BookStatus } from "./types.js";

export class CirculationService {
  private readonly policy: LoanPolicy;

  constructor(private readonly repo: LibraryRepository, private readonly bus?: EventBus) {
    this.policy = new LoanPolicy(repo);
  }

  listLoans(query?: Parameters<LibraryRepository["list"]>[1]) {
    return this.repo.list("loans", query);
  }

  getLoan(loanId: string) {
    return this.repo.get("loans", loanId) as Record<string, unknown> | undefined;
  }

  updateLoan(loanId: string, values: Record<string, unknown>) {
    return this.repo.update("loans", loanId, values);
  }

  listReservations(query?: Parameters<LibraryRepository["list"]>[1]) {
    return this.repo.list("reservations", query);
  }

  borrow(input: { bookId: string; userId: string; branchId?: string; deviceId?: string; idempotencyKey: string }) {
    const existing = this.repo.findLoanByIdempotency(input.idempotencyKey);
    if (existing) return existing;
    const book = this.repo.findBook(input.bookId);
    if (!book) throw new DomainError("BOOK_NOT_FOUND", "Book not found");
    const user = this.repo.findUserById(input.userId);
    if (!user || user.role !== "reader") throw new DomainError("READER_NOT_FOUND", "Reader not found");
    if (book.status !== "on_shelf") throw new DomainError("BOOK_UNAVAILABLE", "Book is not available");
    const activeCount = this.repo.count("loans", "user_id = @userId AND status IN ('active','overdue')", { userId: input.userId });
    if (activeCount >= this.policy.values().maxLoans) throw new DomainError("MAX_LOANS_REACHED", "Reader has reached the loan limit");

    const borrowedAt = new Date();
    const dueAt = new Date(borrowedAt);
    dueAt.setDate(dueAt.getDate() + this.policy.values().loanDays);
    assertBookTransition(book.status as BookStatus, "borrowed");
    this.repo.update("books", input.bookId, { status: "borrowed" });
    const loan = this.repo.insert("loans", {
      id: randomUUID(),
      book_id: input.bookId,
      user_id: input.userId,
      branch_id: input.branchId ?? asString(book.branch_id),
      device_id: input.deviceId ?? null,
      borrowed_at: borrowedAt.toISOString(),
      due_at: dueAt.toISOString(),
      returned_at: null,
      renew_count: 0,
      status: "active",
      idempotency_key: input.idempotencyKey
    });
    this.bus?.publishNoWait("circulation.borrowed", {
      loanId: String((loan as { id: string }).id), bookId: input.bookId, userId: input.userId,
      branchId: input.branchId ?? asString(book.branch_id), deviceId: input.deviceId ?? null,
      action: "borrowed", ts: borrowedAt.toISOString(), dueAt: dueAt.toISOString()
    });
    return loan;
  }

  returnLoan(input: { loanId: string }) {
    const loan = this.repo.get("loans", input.loanId) as Record<string, unknown> | undefined;
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found");
    if (loan.status === "returned") return loan;
    const book = this.repo.findBook(asString(loan.book_id));
    if (!book) throw new DomainError("BOOK_NOT_FOUND", "Book not found");
    assertBookTransition(book.status as BookStatus, "on_shelf");
    this.repo.update("books", asString(loan.book_id), { status: "on_shelf" });
    const returnedAt = new Date().toISOString();
    const result = this.repo.update("loans", input.loanId, { status: "returned", returned_at: returnedAt });
    this.bus?.publishNoWait("circulation.returned", {
      loanId: input.loanId, bookId: asString(loan.book_id), userId: asString(loan.user_id),
      branchId: asString(loan.branch_id), deviceId: loan.device_id as string | null,
      action: "returned", ts: returnedAt
    });
    return result;
  }

  renew(input: { loanId: string }) {
    const loan = this.repo.get("loans", input.loanId) as Record<string, unknown> | undefined;
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found");
    if (!["active", "overdue"].includes(asString(loan.status))) throw new DomainError("LOAN_NOT_ACTIVE", "Only active loans can be renewed");
    const policy = this.policy.values();
    if (asNumber(loan.renew_count) >= policy.maxRenewals) throw new DomainError("MAX_RENEWALS_REACHED", "Renewal limit reached");
    const reservedByAnotherReader = this.repo.count(
      "reservations",
      "book_id = @bookId AND user_id != @userId AND status = 'active' AND expires_at > @now",
      { bookId: asString(loan.book_id), userId: asString(loan.user_id), now: new Date().toISOString() }
    );
    if (reservedByAnotherReader > 0) throw new DomainError("LOAN_RESERVED", "This book is reserved by another reader");
    const dueAt = new Date(asString(loan.due_at));
    dueAt.setDate(dueAt.getDate() + policy.loanDays);
    const result = this.repo.update("loans", input.loanId, { renew_count: asNumber(loan.renew_count) + 1, due_at: dueAt.toISOString(), status: "active" });
    this.bus?.publishNoWait("circulation.renewed", {
      loanId: input.loanId, bookId: asString(loan.book_id), userId: asString(loan.user_id),
      branchId: asString(loan.branch_id), deviceId: loan.device_id as string | null,
      action: "renewed", ts: new Date().toISOString(), dueAt: dueAt.toISOString(), renewCount: asNumber(loan.renew_count) + 1
    });
    return result;
  }

  reserve(input: { bookId: string; userId: string }) {
    const book = this.repo.findBook(input.bookId);
    if (!book) throw new DomainError("BOOK_NOT_FOUND", "Book not found");
    const expires = new Date();
    expires.setDate(expires.getDate() + 3);
    return this.repo.insert("reservations", {
      book_id: input.bookId,
      user_id: input.userId,
      expires_at: expires.toISOString(),
      status: "active"
    });
  }
}
