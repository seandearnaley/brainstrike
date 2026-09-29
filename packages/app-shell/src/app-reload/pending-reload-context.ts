import { createContext, useContext } from 'react';

export interface PendingReload {
  readonly cancel: () => void;
}

/** `null` is a mounted gate with nothing pending; `undefined` is no gate at all. */
export const PendingReloadContext = createContext<PendingReload | null | undefined>(undefined);

export function usePendingReload(): PendingReload | null {
  const context = useContext(PendingReloadContext);
  if (context === undefined) {
    throw new Error('usePendingReload must be used within an AppReloadGate');
  }
  return context;
}
