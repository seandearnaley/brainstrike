import { useState } from 'react';

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
 * React's supported previous-render state pattern replaces the record before
 * children observe it. This avoids a ref write that can leak from discarded
 * concurrent work, while shallow-equal follow-up records reuse the committed
 * identity without an effect-delayed value.
 *
 * CALLER CONTRACT: `record` must be memoized (or otherwise stable across a
 * re-render of the same component with unchanged inputs). A record whose
 * values get fresh identities on every render pass never reaches
 * shallow-equality, so the render-phase update re-fires forever and React
 * throws "Too many re-renders". An actual value change also costs one extra
 * render pass of the calling component, unlike the previous ref implementation.
 */
export function useStableRecord<T>(record: Record<string, T>): Record<string, T> {
  const [stableRecord, setStableRecord] = useState(record);
  if (!shallowEqualRecords(stableRecord, record)) {
    setStableRecord(record);
    return record;
  }
  return stableRecord;
}
