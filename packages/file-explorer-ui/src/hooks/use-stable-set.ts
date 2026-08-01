import { useRef } from 'react';
import { setsEqual } from '../utils/sets-equal';

/**
 * Retains the previous Set when a new instance has equal membership.
 * Membership changes advance the identity before children render.
 *
 * The render-phase ref write is a memoization-cache update, matching
 * `useStableRecord` in @brainstrike/ui. Replacement is keyed on pure value
 * equality, so a discarded concurrent render cannot produce an incorrect
 * result, and membership changes do not cost an extra render pass.
 */
export function useStableSet<T>(value: Set<T>): Set<T> {
  const stableValueRef = useRef(value);
  if (!setsEqual(stableValueRef.current, value)) {
    stableValueRef.current = value;
  }
  return stableValueRef.current;
}
