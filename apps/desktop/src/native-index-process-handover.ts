import type { IndexerHostManager } from './indexer-host-manager';
import type { IndexerRuntimeBorrowers } from './indexer-runtime';
import { NativeAuthorityTransitionError } from './native-authority-transition';
import type { NativeIndexActivationGraph } from './native-index-graph';
import type { NativeIndexLifecycle } from './native-index-lifecycle-owner';
import type { NativeIndexRuntime } from './native-index-runtime';

interface Dependencies {
  graph(): NativeIndexActivationGraph | undefined;
  lifecycle(): Promise<NativeIndexLifecycle>;
  onError(stage: string, error: unknown): void;
  released(): void;
  retireSources(manager: IndexerHostManager): Promise<void>;
  readonly runtime: NativeIndexRuntime;
}

/** Callbacks into the existing native owner; the process supervisor alone replaces children. */
export function createNativeIndexProcessHandover(
  dependencies: Dependencies
): IndexerRuntimeBorrowers {
  return {
    lost: async () => {
      const graph = dependencies.graph();
      graph?.controller.abort(new NativeAuthorityTransitionError('Native writer was lost.'));
      void dependencies.runtime
        .retireReads()
        .catch((error: unknown) => dependencies.onError('lost writer reads', error));
      const lifecycle = await dependencies.lifecycle();
      // A physical replacement exists before native rebind creates its graph.
      // The same native lifecycle still owns that pending generation.
      const generation = graph?.generation ?? (await lifecycle.state()).generation;
      const state = await lifecycle.dispatch({ generation, kind: 'host-lost' });
      return {
        failed: async (error) => {
          await lifecycle.dispatch({
            error,
            generation: state.generation,
            kind: 'failure',
            message: 'Native indexer process recovery failed.',
          });
        },
        ready: async () => {
          await lifecycle.dispatch({ generation: state.generation, kind: 'host-ready' });
        },
      };
    },
    released: () => {
      dependencies.runtime.indexReleased();
      dependencies.released();
    },
    retire: async (manager) => {
      const results = await Promise.allSettled([
        dependencies.retireSources(manager),
        dependencies.runtime.retireIndexBorrowers(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (failures.length) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Native writer borrowers did not retire.');
      }
    },
  };
}
