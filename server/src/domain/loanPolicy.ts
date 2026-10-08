import type { LibraryRepository } from "../persistence/repositories.js";

export type LoanPolicyValues = {
  loanDays: number;
  maxLoans: number;
  maxRenewals: number;
  finePerDayCents: number;
  overdueGraceDays: number;
  thresholds: Record<string, { min?: number; max?: number }>;
};

// Strategy pattern: loan rules are loaded from rules table instead of hard-coded in circulation commands.
export class LoanPolicy {
  constructor(private readonly repo: LibraryRepository) {}

  values(): LoanPolicyValues {
    const rules = new Map<string, unknown>();
    for (const row of this.repo.getRules() as Array<{ key: string; value_json: string }>) {
      rules.set(row.key, JSON.parse(row.value_json));
    }
    return {
      loanDays: Number(rules.get("loan_days") ?? 30),
      maxLoans: Number(rules.get("max_loans") ?? 8),
      maxRenewals: Number(rules.get("max_renewals") ?? 2),
      finePerDayCents: Number(rules.get("fine_per_day_cents") ?? 50),
      overdueGraceDays: Number(rules.get("overdue_grace_days") ?? 1),
      thresholds: (rules.get("alert_thresholds") as LoanPolicyValues["thresholds"]) ?? {}
    };
  }
}
