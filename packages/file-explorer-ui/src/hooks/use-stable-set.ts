import { useState } from 'react';
import { setsEqual } from '../utils/sets-equal';

/**
 * Retains the previous Set when a new instance has equal membership.
 * Membership changes advance the identity before children render.
 */
export function useStableSet<T>(value: Set<T>): Set<T> {
  const [stableValue, setStableValue] = useState(value);
  if (setsEqual(stableValue, value)) {
    return stableValue;
  }

  setStableValue(value);
  return value;
}
