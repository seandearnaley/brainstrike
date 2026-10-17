import { Button } from '@brainstrike/ui';
import { AlertTriangle } from 'lucide-react';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import type { StateHealthCapability, StateStoreHealth } from './state-health-capability';

type Action = 'check' | 'restart' | 'folder';

type View =
  | { readonly kind: 'checking' }
  | { readonly kind: 'healthy' }
  | { readonly health: StateStoreHealth; readonly kind: 'damaged' }
  | { readonly kind: 'unreadable'; readonly message: string };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const ACTION_FAILURE: Record<Action, string> = {
  check: 'Couldn’t check the conversation store again',
  folder: 'Couldn’t open the data folder',
  restart: 'Couldn’t restart the agent host',
};

const CHECKING: View = { kind: 'checking' };

interface HealthStore {
  getSnapshot(): View;
  /** Reads the store's health again and publishes the result; never rejects. */
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/**
 * One health view per capability, read through `useSyncExternalStore`. The
 * first subscriber starts the first read, so no render-time effect sets state.
 */
const stores = new WeakMap<StateHealthCapability, HealthStore>();

function healthStore(capability: StateHealthCapability): HealthStore {
  const existing = stores.get(capability);
  if (existing) {
    return existing;
  }
  let view: View = CHECKING;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: View): void => {
    view = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const refresh = async (): Promise<void> => {
    try {
      const health = await capability.read();
      publish(health.stateDamage === null ? { kind: 'healthy' } : { health, kind: 'damaged' });
    } catch (cause) {
      publish({ kind: 'unreadable', message: messageOf(cause) });
    }
  };
  const store: HealthStore = {
    getSnapshot: () => view,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!started) {
        started = true;
        void refresh();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
  stores.set(capability, store);
  return store;
}

const noSubscription = (): (() => void) => () => undefined;
const checkingSnapshot = (): View => CHECKING;

/**
 * A damaged canonical state store (BST-1880). The agent host opens a damaged
 * state DB read-only and keeps every file, so conversations read but nothing
 * new saves. This strip says so, with the store's own finding, and offers both
 * ways to look again: re-read the running host's view, or restart the agent
 * host so its store reopens and checks itself again. Healthy renders nothing.
 */
export function StateStoreDamageNotice({
  capability,
}: {
  readonly capability: StateHealthCapability | null;
}): ReactElement | null {
  const store = capability ? healthStore(capability) : null;
  const view = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? checkingSnapshot
  );
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const run = (action: Action, work: () => Promise<void>, recheck: boolean): void => {
    if (!store) {
      return;
    }
    setBusy(action);
    setActionError(null);
    void (async () => {
      try {
        await work();
        if (recheck) {
          await store.refresh();
          setCheckedAt(new Date());
        }
      } catch (cause) {
        setActionError(`${ACTION_FAILURE[action]}: ${messageOf(cause)}`);
      } finally {
        setBusy(null);
      }
    })();
  };

  if (!capability || view.kind === 'checking' || view.kind === 'healthy') {
    return null;
  }
  return (
    <div
      className="flex items-start gap-3 border-destructive/30 border-b bg-destructive/10 px-4 py-2 text-sm"
      data-testid="state-store-damage-notice"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-1">
        {view.kind === 'damaged' ? (
          <>
            <p className="font-medium">
              BrainStrike’s conversation store is damaged, so it opened read-only.
            </p>
            <p>
              Your conversations can be read, but new messages and changes can’t be saved. Nothing
              was deleted or replaced.
            </p>
            <details>
              <summary className="cursor-pointer">Details</summary>
              <p className="break-words font-mono text-xs">{view.health.stateDamage}</p>
              {view.health.unreadableRecords > 0 ? (
                <p className="text-xs">
                  {view.health.unreadableRecords === 1
                    ? '1 record could not be read.'
                    : `${view.health.unreadableRecords} records could not be read.`}
                </p>
              ) : null}
            </details>
          </>
        ) : (
          <p>BrainStrike couldn’t check its conversation store: {view.message}</p>
        )}
        {checkedAt && view.kind === 'damaged' ? (
          <p className="text-xs" role="status">
            Checked again at {checkedAt.toLocaleTimeString()}: still damaged.
          </p>
        ) : null}
        {actionError ? <p className="text-destructive text-xs">{actionError}</p> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            disabled={busy !== null}
            onClick={() => run('folder', () => capability.showDataFolder(), false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Show data folder
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => run('check', async () => undefined, true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy === 'check' ? 'Checking…' : 'Check again'}
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => run('restart', () => capability.restartHost(), true)}
            size="sm"
            title="Stops and relaunches the agent host, so it opens the store and checks it again. Running replies stop."
            type="button"
            variant="outline"
          >
            {busy === 'restart' ? 'Restarting…' : 'Restart agent host and check'}
          </Button>
        </div>
      </div>
    </div>
  );
}
