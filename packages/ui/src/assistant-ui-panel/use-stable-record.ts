import { useRef } from 'react';

function shallowEqualRecords<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  if (a === b) {
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key) || a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the PREVIOUS record identity while the incoming record stays
 * shallow-equal. Use for derived per-turn maps that are recomputed on every
 * streamed update but rarely change in value (e.g. toolCallId → duration):
 * feeding the raw recomputed record into a context provider re-renders every
 * consumer on every chunk; the stable identity makes those re-renders happen
 * only when the data actually changed.
 *
 * The render-phase ref write is the standard memoization-cache pattern:
 * replacement is keyed on pure value-equality, so a discarded concurrent
 * render can only ever swap in an equal-or-newer cache entry — never an
 * incorrect result.
 */
export function useStableRecord<T>(record: Record<string, T>): Record<string, T> {
  const ref = useRef(record);
  if (!shallowEqualRecords(ref.current, record)) {
    ref.current = record;
  }
  return ref.current;
}
