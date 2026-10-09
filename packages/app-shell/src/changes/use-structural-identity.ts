import { useState } from 'react';

/**
 * The first value seen for each JSON structure, so a structurally equal fresh
 * literal from the caller settles onto one stable reference.
 *
 * Held as state (React's "adjust state when a prop changes"), not as
 * `useMemo(() => value, [key])`: the React Compiler keys a memo on what its body
 * reads, so that memo would return every render's new literal.
 */
export function useStructuralIdentity<T>(value: T): T {
  const key = JSON.stringify(value);
  const [held, setHeld] = useState({ key, value });
  if (held.key === key) {
    return held.value;
  }
  setHeld({ key, value });
  return value;
}
