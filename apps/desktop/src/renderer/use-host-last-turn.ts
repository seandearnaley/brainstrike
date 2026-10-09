import type { HostLogRow } from '@brainstrike/agent-host';
import { useLastTurnFollower } from '@brainstrike/app-shell/changes/use-last-turn-follower';
import { useEffect, useSyncExternalStore } from 'react';

/** The committed session's observable surface: its rows, as the host committed them. */
export interface HostLastTurnSource {
  readonly getSnapshot: () => { readonly rows: readonly HostLogRow[] };
  readonly subscribe: (listener: () => void) => () => void;
}

/** Committed facts that can change a run's Changes: a finished tool, an edit, a turn boundary, the run's end. */
const WORKSPACE_CHANGE_EVENTS: ReadonlySet<string> = new Set([
  'effect.finished',
  'run.finished',
  'workspace.edit.recorded',
  'workspace.snapshot.recorded',
]);

function newestRunId(rows: readonly HostLogRow[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index]?.event;
    if (event?.type === 'run.started') {
      return event.runId;
    }
  }
  return null;
}

function workspaceChangeCount(rows: readonly HostLogRow[]): number {
  return rows.filter(({ event }) => WORKSPACE_CHANGE_EVENTS.has(event.type)).length;
}

/**
 * The Changes surface's "Last Turn" follows this host thread (BST-1977): its
 * newest committed run is the identity "Last Turn" shows, published when the
 * thread becomes active and as each run starts, so a viewer watches the new
 * turn fill in. Each committed change to a run's workspace asks a "Last Turn"
 * view of the thread to re-resolve; the shared follower gates on the active
 * thread and throttles exactly as it does for legacy threads.
 */
export function useHostLastTurn(threadId: string, source: HostLastTurnSource): void {
  const latestRunId = useSyncExternalStore(
    source.subscribe,
    () => newestRunId(source.getSnapshot().rows),
    () => newestRunId(source.getSnapshot().rows)
  );
  const { publishRun, refresh } = useLastTurnFollower(threadId, latestRunId);
  // Committed rows are the events: a new run publishes, a workspace change re-resolves.
  useEffect(() => {
    let run: string | null = null;
    let changes = 0;
    const observe = (): void => {
      const { rows } = source.getSnapshot();
      const newest = newestRunId(rows);
      if (newest !== run) {
        run = newest;
        if (newest) {
          publishRun(newest);
        }
      }
      const count = workspaceChangeCount(rows);
      if (count !== changes) {
        changes = count;
        refresh();
      }
    };
    observe();
    return source.subscribe(observe);
  }, [publishRun, refresh, source]);
}
