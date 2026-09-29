import { hasDurableAssistantUsageCapability } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { AppReloadProvider } from '@brainstrike/ui';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from 'react';
import { type ChunkReloadGuardOptions, writeChunkReloadMarker } from './chunk-reload-guard';
import { PendingReloadContext } from './pending-reload-context';
import { ReloadConfirmDialog } from './reload-confirm-dialog';
import { useRunningAssistantRuns } from './use-running-assistant-runs';

const logger = createLogger('AppReloadGate');

export interface AppReloadGateProps {
  /** Identifies this build; a reload that lands on the same one did not fix the load. */
  readonly buildId: string;
  readonly children: ReactNode;
  readonly getStorage?: ChunkReloadGuardOptions['getStorage'];
  /** Injected so tests can count reloads. */
  readonly reload?: (() => void) | undefined;
}

type GateProps = Omit<AppReloadGateProps, 'reload'> & { readonly reload: () => void };

const reloadWindow = (): void => window.location.reload();

/** Writes the guard marker, then reloads: the next startup reads the marker to learn a reload was tried. */
function useReloadAction({ buildId, getStorage, reload }: Omit<GateProps, 'children'>): () => void {
  return useCallback(() => {
    writeChunkReloadMarker({ buildId, getStorage });
    reload();
  }, [buildId, getStorage, reload]);
}

/** Desktop: the main process owns the run and it reattaches after a reload, so there is nothing to ask. */
function ImmediateReloadGate(props: GateProps): ReactElement {
  const requestAppReload = useReloadAction(props);
  return (
    <PendingReloadContext value={null}>
      <AppReloadProvider requestAppReload={requestAppReload}>{props.children}</AppReloadProvider>
    </PendingReloadContext>
  );
}

type Phase =
  | { readonly kind: 'idle' }
  /** The user is being asked; `runningCount` is `null` when the count could not be read. */
  | { readonly kind: 'asking'; readonly runningCount: number | null }
  | { readonly kind: 'waiting' };

const IDLE: Phase = { kind: 'idle' };
const WAITING: Phase = { kind: 'waiting' };

/**
 * Web: a reload stops every run in this page, so a reload with runs in flight,
 * or with a count we cannot read, waits for a decision. Nothing here ever
 * reloads on its own: it reloads on a request that finds no runs, on a click,
 * or when the run count reaches zero after the user chose to wait.
 */
function ConfirmedReloadGate(props: GateProps): ReactElement {
  const projection = useRunningAssistantRuns();
  const [phase, setPhase] = useState<Phase>(IDLE);
  const performReload = useReloadAction(props);

  const requestAppReload = useCallback(() => {
    if (projection.status === 'ready' && projection.runningCount === 0) {
      performReload();
      return;
    }
    if (projection.status === 'ready') {
      setPhase({ kind: 'asking', runningCount: projection.runningCount });
      return;
    }
    logger.warn('Reload requested while assistant runs could not be counted', {
      ...(projection.status === 'error' ? { error: projection.error } : {}),
      status: projection.status,
    });
    setPhase({ kind: 'asking', runningCount: null });
  }, [performReload, projection]);

  // Reloading the page is an effect on the outside world that must follow the count
  // reaching zero. The effect keys on this boolean, not on the projection, so a later
  // snapshot with the same meaning (or a double effect) cannot reload twice.
  const reloadIsDue =
    phase.kind === 'waiting' && projection.status === 'ready' && projection.runningCount === 0;
  const reloadWhenDue = useEffectEvent(performReload);
  // biome-ignore lint/plugin: the trigger is the external run count reaching zero, not an event this component handles
  useEffect(() => {
    if (reloadIsDue) {
      reloadWhenDue();
    }
  }, [reloadIsDue]);

  const cancel = useCallback(() => setPhase(IDLE), []);
  const reloadWhenFinished = useCallback(() => setPhase(WAITING), []);
  const reloadNow = useCallback(() => {
    performReload();
    setPhase(IDLE);
  }, [performReload]);

  // Waiting on a count that has become unreadable is the unknown-state ask again,
  // derived rather than stored so it clears itself when the count is readable.
  const waitingBlind = phase.kind === 'waiting' && projection.status !== 'ready';
  const askedRuns =
    phase.kind === 'asking' ? { count: phase.runningCount } : waitingBlind ? { count: null } : null;
  const pendingReload = useMemo(
    () => (phase.kind === 'waiting' && !waitingBlind ? { cancel } : null),
    [cancel, phase.kind, waitingBlind]
  );

  return (
    <PendingReloadContext value={pendingReload}>
      <AppReloadProvider requestAppReload={requestAppReload}>
        {props.children}
        {askedRuns === null ? null : (
          <ReloadConfirmDialog
            onCancel={cancel}
            onReloadNow={reloadNow}
            onReloadWhenFinished={reloadWhenFinished}
            runningCount={askedRuns.count}
          />
        )}
      </AppReloadProvider>
    </PendingReloadContext>
  );
}

/**
 * Supplies `requestAppReload` to the failed-chunk UI. Which gate applies is the
 * capability that a run survives a renderer reload, never the platform.
 */
export function AppReloadGate({
  reload = reloadWindow,
  ...props
}: AppReloadGateProps): ReactElement {
  // Read once per mount: the two gates are different component types around the whole
  // shell, so an answer that changed after the first render would remount the application.
  const [durableRuns] = useState(hasDurableAssistantUsageCapability);
  return durableRuns ? (
    <ImmediateReloadGate {...props} reload={reload} />
  ) : (
    <ConfirmedReloadGate {...props} reload={reload} />
  );
}
