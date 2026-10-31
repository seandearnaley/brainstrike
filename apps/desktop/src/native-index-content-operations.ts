import { NativeAuthorityTransitionError as TransitionError } from '@brainstrike/assistant-service/node-native-text-services';
import type { NativeIndexActivationGraph as Graph } from './native-index-graph';
import type { NativeIndexRuntime } from './native-index-runtime';

interface Dependencies {
  assertCurrent(graph: Graph): void;
  closeNativeOwner(): Promise<void>;
  closeOwned(destroy: boolean): Promise<void>;
  getGraph(): Graph | undefined;
  retireProfile(): Promise<void>;
  runtime: Pick<NativeIndexRuntime, 'closeIndex' | 'cleanupCollection'>;
  stopSources(): Promise<void>;
}

/** Content operations borrow the existing lifecycle and physical writer; they own no state. */
export function createNativeIndexContentOperations({
  assertCurrent,
  closeNativeOwner,
  closeOwned,
  getGraph,
  runtime,
  retireProfile,
  stopSources,
}: Dependencies) {
  const cleanupNative = async (work: () => Promise<void>): Promise<void> => {
    await stopSources();
    await closeNativeOwner();
    await runtime.closeIndex();
    const failures: unknown[] = [];
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
    try {
      await runtime.closeIndex();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Source cleanup and physical retirement failed');
    }
  };
  return {
    cleanupCollection: (id: string) => cleanupNative(() => runtime.cleanupCollection(id)),
    destroyAndRetireProfile: async () => {
      await stopSources();
      await closeOwned(true);
      await retireProfile();
    },
    destroyNativeOwner: async () => {
      await stopSources();
      await closeOwned(true);
      await closeNativeOwner();
    },
    requestWorkspaceScan: async (rootId: string): Promise<void> => {
      const current = getGraph();
      if (!current) {
        throw new TransitionError('Native workspace indexing is not active.');
      }
      assertCurrent(current);
      const sources = current.sources;
      const trigger = sources?.workspaceTriggers.get(rootId);
      if (!(sources && trigger) || current.settings.paused) {
        throw new TransitionError('Native workspace indexing is not active for this root.');
      }
      sources.controller.signal.throwIfAborted();
      await trigger();
      assertCurrent(current);
      sources.controller.signal.throwIfAborted();
    },
  };
}
