import { useSyncExternalStore } from 'react';

export interface AppReloadState {
  /** A reload was already tried for this build, so another one may not help. */
  readonly reloadAlreadyAttempted: boolean;
  /** A lazy chunk failed to load; only a full app reload can recover it. */
  readonly required: boolean;
}

let state: AppReloadState = { reloadAlreadyAttempted: false, required: false };
const listeners = new Set<() => void>();

// The snapshot keeps its identity when nothing changed, as useSyncExternalStore requires.
function setState(next: AppReloadState): void {
  if (
    next.required === state.required &&
    next.reloadAlreadyAttempted === state.reloadAlreadyAttempted
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export const appReloadStore = {
  getSnapshot: (): AppReloadState => state,
  markReloadAlreadyAttempted: (): void => setState({ ...state, reloadAlreadyAttempted: true }),
  markRequired: (): void => setState({ ...state, required: true }),
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useAppReloadState(): AppReloadState {
  return useSyncExternalStore(appReloadStore.subscribe, appReloadStore.getSnapshot);
}
