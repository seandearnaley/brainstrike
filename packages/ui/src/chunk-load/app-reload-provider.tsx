import { type ReactElement, type ReactNode, useMemo } from 'react';
import { AppReloadContext } from './app-reload-context';

/** Supplies the host's full-app reload; the shell owns how a reload happens. */
export function AppReloadProvider({
  children,
  requestAppReload,
}: {
  readonly children: ReactNode;
  readonly requestAppReload: () => void;
}): ReactElement {
  const value = useMemo(() => ({ requestAppReload }), [requestAppReload]);
  return <AppReloadContext value={value}>{children}</AppReloadContext>;
}
