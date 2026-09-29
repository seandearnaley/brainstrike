import { createContext, useContext } from 'react';

interface AppReloadContextValue {
  readonly requestAppReload: () => void;
}

export const AppReloadContext = createContext<AppReloadContextValue | null>(null);

export function useRequestAppReload(): () => void {
  const context = useContext(AppReloadContext);
  if (context === null) {
    throw new Error('useRequestAppReload must be used within an AppReloadProvider');
  }
  return context.requestAppReload;
}
