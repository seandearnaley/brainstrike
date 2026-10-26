import type { createNativeCanonicalPublication } from '@brainstrike/canonical-ingestion';
import type { WatcherHealthTransition } from '@brainstrike/types';

interface Dependencies {
  /** The root's watch failure was recorded or cleared: its status changed. */
  readonly changed: () => void;
  readonly onError: (operation: string, error: unknown) => void;
  readonly publication: () =>
    | Pick<ReturnType<typeof createNativeCanonicalPublication>, 'invalidateScope'>
    | undefined;
  readonly rootId: string;
  readonly signal: AbortSignal;
  readonly watchFailures: Map<string, string>;
  readonly workspace: () => { trigger(): Promise<void> } | undefined;
}

/** Recovery invalidates source proofs without retiring authorized committed rows. */
export function createNativeIndexWatchHealthHandler(dependencies: Dependencies) {
  return (health: WatcherHealthTransition): void => {
    if (dependencies.signal.aborted) {
      return;
    }
    if (health.state === 'healthy') {
      const recovering = dependencies.watchFailures.delete(dependencies.rootId);
      if (recovering) {
        dependencies.changed();
      }
      const workspace = dependencies.workspace();
      if (recovering && workspace) {
        workspace
          .trigger()
          .catch((error: unknown) => dependencies.onError('watch recovery scan', error));
      }
      return;
    }
    if (!(health.state === 'degraded' || health.state === 'failed' || health.state === 'stopped')) {
      return;
    }
    const reason = health.failure?.message ?? `Workspace watcher is ${health.state}.`;
    dependencies.publication()?.invalidateScope({ kind: 'workspace', rootId: dependencies.rootId });
    if (
      health.state === 'degraded' &&
      health.failure?.code === 'rescan-required' &&
      !health.failure.terminal
    ) {
      return;
    }
    dependencies.watchFailures.set(dependencies.rootId, reason);
    dependencies.changed();
    dependencies.onError('workspace watcher health', new Error(reason));
  };
}
