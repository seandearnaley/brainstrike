import { useState } from 'react';

/**
 * Returns the PREVIOUS value while its structural `key` is unchanged. For a
 * layout derived from the message's parts, which get a new identity on every
 * streamed chunk: feeding the raw value into a context re-renders every step
 * of the group per chunk. Same supported previous-render state pattern as
 * `useStableRecord`; `key` must be a pure function of the value.
 */
export function useStableByKey<T>(value: T, key: string): T {
  const [stable, setStable] = useState({ key, value });
  if (stable.key !== key) {
    setStable({ key, value });
    return value;
  }
  return stable.value;
}
