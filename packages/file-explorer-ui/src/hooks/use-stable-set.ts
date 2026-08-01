import { useEffect, useMemo, useRef } from 'react';
import { setsEqual } from '../utils/sets-equal';

/**
 * Retains the last committed Set when a new instance has equal membership.
 * A membership change advances the identity after the component commits.
 */
export function useStableSet<T>(value: Set<T>): Set<T> {
  const previousValueRef = useRef<Set<T> | null>(null);
  const stableValue = useMemo(() => {
    const previousValue = previousValueRef.current;
    if (previousValue && setsEqual(previousValue, value)) {
      return previousValue;
    }
    return value;
  }, [value]);

  useEffect(() => {
    previousValueRef.current = stableValue;
  }, [stableValue]);

  return stableValue;
}
