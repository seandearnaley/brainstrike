/**
 * Zustand persist hydration seam.
 *
 * Boot-ordering call sites (the inline-fixture subscription, the file-system
 * restore in `use-file-system-context`) must run work only AFTER the store's
 * ASYNC persist hydration completes. They share this narrowing guard so the two
 * hydration checks cannot drift apart (AGENTS: avoid copy-paste divergence).
 *
 * Distinct from `hasPersistApi` in `hooks/recursive-selection-utils.ts`, which
 * narrows on `getOptions` for immediate-persist writes, not hydration ordering.
 */
export interface PersistHydrationApi {
  hasHydrated: () => boolean;
  onFinishHydration: (callback: () => void) => () => void;
}

export function hasPersistHydrationApi<S extends object>(
  store: S
): store is S & { persist: PersistHydrationApi } {
  const persist = (store as { persist?: unknown }).persist;
  if (typeof persist !== 'object' || persist === null) {
    return false;
  }
  const api = persist as Record<string, unknown>;
  return typeof api['hasHydrated'] === 'function' && typeof api['onFinishHydration'] === 'function';
}
