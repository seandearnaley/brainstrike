import type { ReactElement, ReactNode } from 'react';
import { AppReloadContext } from './app-reload-context';

/** Supplies the host's full-app reload; the shell owns how a reload happens. */
export function AppReloadProvider({
  children,
  requestAppReload,
}: {
  readonly children: ReactNode;
  readonly requestAppReload: () => void;
}): ReactElement {
  const value = { requestAppReload };
  return <AppReloadContext value={value}>{children}</AppReloadContext>;
}
