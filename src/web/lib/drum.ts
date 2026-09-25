export type DrumCell = { readonly kind: 'digit'; readonly value: number } | { readonly kind: 'char'; readonly value: string };

export interface DrumState {
  readonly cells: readonly DrumCell[];
  /** The drum is built again: its strips start at 0 and roll in. */
  readonly rebuild: boolean;
}

const DIGIT = /^[0-9]$/;

/** The value with every digit replaced by 0: two values with the same shape keep the same drum positions. */
const shapeOf = (text: string): string => text.replace(/[0-9]/g, '0');

/**
 * The drum cells of `next`, and whether the drum must be built again: on first show (`prev` null) or when the shape
 * changed (another length, a moved separator, another unit). Otherwise only the digits that differ roll.
 */
export function drumDigits(prev: string | null, next: string): DrumState {
  const cells = [...next].map((char): DrumCell =>
    DIGIT.test(char) ? { kind: 'digit', value: Number(char) } : { kind: 'char', value: char },
  );
  return { cells, rebuild: prev === null || shapeOf(prev) !== shapeOf(next) };
}
