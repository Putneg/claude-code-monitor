import { requestBucket, type DayRange } from './range.js';
import { encodeList, type ViewState } from './view-state.js';

/** Rows in the sessions table (the API allows up to 200). */
export const SESSIONS_LIMIT = 50;

export interface DataRequest {
  /** Changes exactly when either query changes; unit and cumulative are client-side only. */
  readonly key: string;
  readonly overview: string;
  readonly sessions: string;
}

export function dataRequest(view: ViewState, range: DayRange): DataRequest {
  const filter = [
    `from=${range.from}`,
    `to=${range.to}`,
    ...(view.models.length > 0 ? [`models=${encodeList(view.models)}`] : []),
    ...(view.projects.length > 0 ? [`projects=${encodeList(view.projects)}`] : []),
  ];
  const bucket = requestBucket(view.bucket, range);
  const overview = [...filter, `stack=${view.stack}`, ...(bucket === null ? [] : [`bucket=${bucket}`])].join('&');
  const sessions = [...filter, `sort=${view.sort}`, `limit=${SESSIONS_LIMIT}`].join('&');
  return { key: `${overview}|${sessions}`, overview, sessions };
}
