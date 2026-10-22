import { AppReloadProvider } from '@brainstrike/ui';
import { type ReactElement, type ReactNode, useCallback } from 'react';
import { type ChunkReloadGuardOptions, writeChunkReloadMarker } from './chunk-reload-guard';

export interface AppReloadGateProps {
  /** Identifies this build; a reload that lands on the same one did not fix the load. */
  readonly buildId: string;
  readonly children: ReactNode;
  readonly getStorage?: ChunkReloadGuardOptions['getStorage'];
  /** Injected so tests can count reloads. */
  readonly reload?: (() => void) | undefined;
}

const reloadWindow = (): void => window.location.reload();

/**
 * Supplies `requestAppReload` to the failed-chunk UI. The main process owns the
 * run and it reattaches after a reload, so there is nothing to ask: this writes
 * the guard marker, then reloads, and the next startup reads the marker to
 * learn a reload was tried.
 */
export function AppReloadGate({
  buildId,
  children,
  getStorage,
  reload = reloadWindow,
}: AppReloadGateProps): ReactElement {
  const requestAppReload = useCallback(() => {
    writeChunkReloadMarker({ buildId, getStorage });
    reload();
  }, [buildId, getStorage, reload]);
  return <AppReloadProvider requestAppReload={requestAppReload}>{children}</AppReloadProvider>;
}
