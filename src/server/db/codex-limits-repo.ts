import type { Db } from './connection.js';

export interface CodexLimitWindowSnapshot {
  /** 0-100. */
  readonly usedPercent: number;
  readonly windowMinutes: number;
  /** Epoch ms, or null when Codex did not say. */
  readonly resetsAt: number | null;
}

export interface CodexCreditsSnapshot {
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
  readonly balance: string | null;
}

/** One Codex rate-limit reading, as a token_count event reported it. */
export interface CodexLimitSnapshot {
  readonly limitId: string;
  readonly planType: string | null;
  readonly primary: CodexLimitWindowSnapshot | null;
  readonly secondary: CodexLimitWindowSnapshot | null;
  readonly credits: CodexCreditsSnapshot | null;
  /** Epoch ms of the event that carried the reading. */
  readonly observedAt: number;
}

export interface CodexLimitsRepo {
  /** Stores the snapshot unless the stored one for its limit id is as new or newer. */
  upsert(snapshot: CodexLimitSnapshot): void;
  /** Every stored snapshot, ordered by limit id. */
  all(): CodexLimitSnapshot[];
}

interface CodexLimitRow {
  limit_id: string;
  plan_type: string | null;
  primary_used_percent: number | null;
  primary_window_minutes: number | null;
  primary_resets_at: number | null;
  secondary_used_percent: number | null;
  secondary_window_minutes: number | null;
  secondary_resets_at: number | null;
  credits_has: number | null;
  credits_unlimited: number | null;
  credits_balance: string | null;
  observed_at: number;
}

const COLUMNS = `limit_id, plan_type, primary_used_percent, primary_window_minutes, primary_resets_at,
  secondary_used_percent, secondary_window_minutes, secondary_resets_at,
  credits_has, credits_unlimited, credits_balance, observed_at`;

// The whole row is replaced, so a window or credits block missing from the newer reading is cleared.
const UPSERT_SQL = `
INSERT INTO codex_rate_limits (${COLUMNS})
VALUES (@limitId, @planType, @primaryUsedPercent, @primaryWindowMinutes, @primaryResetsAt,
        @secondaryUsedPercent, @secondaryWindowMinutes, @secondaryResetsAt,
        @creditsHas, @creditsUnlimited, @creditsBalance, @observedAt)
ON CONFLICT (limit_id) DO UPDATE SET
  plan_type = excluded.plan_type,
  primary_used_percent = excluded.primary_used_percent, primary_window_minutes = excluded.primary_window_minutes,
  primary_resets_at = excluded.primary_resets_at,
  secondary_used_percent = excluded.secondary_used_percent, secondary_window_minutes = excluded.secondary_window_minutes,
  secondary_resets_at = excluded.secondary_resets_at,
  credits_has = excluded.credits_has, credits_unlimited = excluded.credits_unlimited,
  credits_balance = excluded.credits_balance, observed_at = excluded.observed_at
WHERE excluded.observed_at > codex_rate_limits.observed_at`;

const flag = (value: boolean | undefined): number | null => (value === undefined ? null : Number(value));

function toParams(snapshot: CodexLimitSnapshot) {
  return {
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    primaryUsedPercent: snapshot.primary?.usedPercent ?? null,
    primaryWindowMinutes: snapshot.primary?.windowMinutes ?? null,
    primaryResetsAt: snapshot.primary?.resetsAt ?? null,
    secondaryUsedPercent: snapshot.secondary?.usedPercent ?? null,
    secondaryWindowMinutes: snapshot.secondary?.windowMinutes ?? null,
    secondaryResetsAt: snapshot.secondary?.resetsAt ?? null,
    creditsHas: flag(snapshot.credits?.hasCredits),
    creditsUnlimited: flag(snapshot.credits?.unlimited),
    creditsBalance: snapshot.credits?.balance ?? null,
    observedAt: snapshot.observedAt,
  };
}

function toWindow(usedPercent: number | null, windowMinutes: number | null, resetsAt: number | null): CodexLimitWindowSnapshot | null {
  return usedPercent === null || windowMinutes === null ? null : { usedPercent, windowMinutes, resetsAt };
}

function toCredits(row: CodexLimitRow): CodexCreditsSnapshot | null {
  if (row.credits_has === null || row.credits_unlimited === null) return null;
  return { hasCredits: row.credits_has === 1, unlimited: row.credits_unlimited === 1, balance: row.credits_balance };
}

const fromRow = (row: CodexLimitRow): CodexLimitSnapshot => ({
  limitId: row.limit_id,
  planType: row.plan_type,
  primary: toWindow(row.primary_used_percent, row.primary_window_minutes, row.primary_resets_at),
  secondary: toWindow(row.secondary_used_percent, row.secondary_window_minutes, row.secondary_resets_at),
  credits: toCredits(row),
  observedAt: row.observed_at,
});

export function createCodexLimitsRepo(db: Db): CodexLimitsRepo {
  const upsertStmt = db.prepare(UPSERT_SQL);
  const allStmt = db.prepare<[], CodexLimitRow>(`SELECT ${COLUMNS} FROM codex_rate_limits ORDER BY limit_id`);
  return {
    upsert: (snapshot) => {
      upsertStmt.run(toParams(snapshot));
    },
    all: () => allStmt.all().map(fromRow),
  };
}
