import type { ProjectBreakdown, ProjectOption, SessionSummary } from '../../shared/api.js';
import { modelColor, modelLabel } from '../../shared/models.js';
import { EM_DASH, formatDateTime, formatPercent, formatStamp, formatTimeOfDay, formatTokens, formatUsd, zonedDay } from './format.js';

export const TOP_PROJECTS = 8;
export const UNTITLED = '(untitled)';
export const UNKNOWN_PROJECT = '(unknown)';

export interface ProjectRow {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly cost: string;
  readonly tokens: string;
  readonly sessions: number;
  /** Bar width relative to the most expensive listed project, 0-100. */
  readonly barPct: number;
  readonly selected: boolean;
}

/** Each value as a percentage of the largest one (0-100); all zeros when nothing is positive. */
function percentsOfMax(values: readonly number[]): number[] {
  const max = values.reduce((highest, value) => Math.max(highest, value), 0);
  return values.map((value) => (max > 0 ? (value / max) * 100 : 0));
}

export function projectRows(rows: readonly ProjectBreakdown[], selected: readonly string[], limit = TOP_PROJECTS): ProjectRow[] {
  const top = rows.slice(0, limit);
  const bars = percentsOfMax(top.map((row) => row.cost));
  return top.map((row, index) => ({
    id: row.id,
    label: row.label,
    path: row.path,
    cost: formatUsd(row.cost),
    tokens: formatTokens(row.tokensTotal),
    sessions: row.sessions,
    barPct: bars[index] ?? 0,
    selected: selected.includes(row.id),
  }));
}

/** Case-insensitive search over label and path; a blank query returns every project. */
export function matchProjects(projects: readonly ProjectOption[], query: string): ProjectOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...projects];
  return projects.filter((project) => project.label.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle));
}

export interface SessionModel {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

export interface SessionRow {
  readonly index: number;
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly untitled: boolean;
  readonly project: string;
  readonly unknownProject: boolean;
  readonly when: string;
  readonly whenTitle: string;
  readonly models: readonly SessionModel[];
  readonly tokens: string;
  readonly cost: string;
  readonly subShare: string;
  readonly barPct: number;
}

/** 'MM-DD HH:MM → HH:MM' within one local day, otherwise both stamps in full. */
export function sessionSpan(firstTs: string, lastTs: string, timeZone: string): string {
  const sameDay = zonedDay(firstTs, timeZone) === zonedDay(lastTs, timeZone);
  const end = sameDay ? formatTimeOfDay(lastTs, timeZone) : formatStamp(lastTs, timeZone);
  return `${formatStamp(firstTs, timeZone)} → ${end}`;
}

export function sessionRows(sessions: readonly SessionSummary[], timeZone: string): SessionRow[] {
  const bars = percentsOfMax(sessions.map((session) => session.cost));
  return sessions.map((session, index) => {
    const title = session.title?.trim() ?? '';
    return {
      index: index + 1,
      id: session.id,
      shortId: session.id.slice(0, 8),
      title: title.length > 0 ? title : UNTITLED,
      untitled: title.length === 0,
      project: session.projectLabel ?? UNKNOWN_PROJECT,
      unknownProject: session.projectLabel === null,
      when: sessionSpan(session.firstTs, session.lastTs, timeZone),
      whenTitle: `${formatDateTime(session.firstTs, timeZone)} → ${formatDateTime(session.lastTs, timeZone)} (${timeZone})`,
      models: session.models.map((id) => ({ id, label: modelLabel(id), color: modelColor(id) })),
      tokens: formatTokens(session.tokensTotal),
      cost: formatUsd(session.cost),
      subShare: session.subagentCost > 0 && session.cost > 0 ? formatPercent(session.subagentCost / session.cost, 0) : EM_DASH,
      barPct: bars[index] ?? 0,
    };
  });
}
