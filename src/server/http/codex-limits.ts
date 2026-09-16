import type { CodexLimit, CodexLimitWindow } from '../../shared/api.js';
import type { CodexLimitSnapshot, CodexLimitWindowSnapshot } from '../db/codex-limits-repo.js';

const iso = (ms: number): string => new Date(ms).toISOString();

function toWindow(slot: CodexLimitWindow['slot'], window: CodexLimitWindowSnapshot | null): CodexLimitWindow[] {
  if (window === null) return [];
  return [
    {
      slot,
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetsAt: window.resetsAt === null ? null : iso(window.resetsAt),
    },
  ];
}

/** The API shape of a stored reading: present windows only, times as ISO strings. */
export function toCodexLimit(snapshot: CodexLimitSnapshot): CodexLimit {
  return {
    limitId: snapshot.limitId,
    planType: snapshot.planType,
    windows: [...toWindow('primary', snapshot.primary), ...toWindow('secondary', snapshot.secondary)],
    credits: snapshot.credits,
    observedAt: iso(snapshot.observedAt),
  };
}
