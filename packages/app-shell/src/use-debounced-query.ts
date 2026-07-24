import { useEffect, useState } from 'react';

/**
 * Local debounce (mirrors `@brainstrike/hooks` `useDebouncedValue`) — kept local
 * to avoid adding a package dependency just for these two calls. Derived during
 * render is impossible for a time-delayed value, so the setState-in-effect here
 * is the canonical debounce pattern (cleared on every change).
 *
 * Shared by `use-quick-open-files` and `use-file-mentions`, which both key a
 * PGlite live subscription on the debounced query.
 */
export function useDebouncedQuery(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
