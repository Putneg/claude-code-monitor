/** Below this share a bar would round to nothing, so it gets a 1px floor. */
const SLIVER_SHARE = 0.005;

/** CSS width of a thin bar for a share of 0-1: clamped, and a tiny non-zero share stays visible. */
export function meterWidth(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const percent = Math.min(share, 1) * 100;
  const text = `${Number(percent.toFixed(2))}%`;
  return share < SLIVER_SHARE ? `max(1px, ${text})` : text;
}
