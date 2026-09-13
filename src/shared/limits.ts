/** Range used when a request has no from/to: the last 30 local days including today. */
export const DEFAULT_RANGE_DAYS = 30;
/** Ranges up to this many days get hour buckets when the request does not choose one. */
export const AUTO_HOURLY_DAYS = 2;
/** Hour buckets are refused for ranges longer than this many days. */
export const MAX_HOURLY_DAYS = 7;
/** Longest accepted range, about ten years. */
export const MAX_RANGE_DAYS = 3_660;
/** models= and projects= accept at most this many ids ... */
export const MAX_LIST_ITEMS = 100;
/** ... each at most this many characters long. */
export const MAX_LIST_ITEM_LENGTH = 200;
/** Query days stay in four-digit years, so day arithmetic (addDays on the hour axis) can never leave them. */
export const MIN_QUERY_DAY = '2000-01-01';
export const MAX_QUERY_DAY = '2999-12-31';
