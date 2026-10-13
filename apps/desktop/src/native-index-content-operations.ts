import type { SourceImportIndexing } from '@brainstrike/assistant-contract';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import type { NativeIndexActivationGraph as Graph } from './native-index-graph';
import type { NativeIndexRuntime, NativeSourceIdentity } from './native-index-runtime';
import type { NativeIndexSettings } from './native-index-settings';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

interface Dependencies {
  acquire(): Promise<unknown>;
  assertCurrent(graph: Graph): void;
  captureSettings(): Promise<NativeIndexSettings>;
  closeNativeOwner(): Promise<void>;
  closeOwned(destroy: boolean): Promise<void>;
  getGraph(): Graph | undefined;
  retireProfile(): Promise<void>;
  runtime: Pick<NativeIndexRuntime, 'closeIndex' | 'cleanupCollection' | 'cleanupFiles'>;
  stopSources(): Promise<void>;
}

/** Content operations borrow the existing lifecycle and physical writer; they own no state. */
export function createNativeIndexContentOperations({
  acquire,
  assertCurrent,
  captureSettings,
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
    cleanupFiles: (files: readonly NativeSourceIdentity[]) =>
      cleanupNative(() => runtime.cleanupFiles(files)),
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
    publishImportedSources: async (
      embeddingSetId: string | null
    ): Promise<SourceImportIndexing> => {
      if (embeddingSetId === null) {
        return {
          kind: 'pending',
          reason: 'Assign imported files to a collection before indexing.',
        };
      }
      let settings: NativeIndexSettings;
      try {
        settings = await captureSettings();
      } catch (error) {
        if (error instanceof NativeIndexSetupRequiredError) {
          return { kind: 'pending', reason: error.message };
        }
        throw error;
      }
      if (!settings.enabled || settings.managedCollectionId !== embeddingSetId) {
        return {
          kind: 'pending',
          reason: 'Select this collection in Workspace Index to process its imported files.',
        };
      }
      if (settings.paused) {
        return { kind: 'pending', reason: 'Resume Workspace Index to process the imported files.' };
      }
      await acquire();
      const graph = getGraph();
      if (
        !graph ||
        graph.settings.managedCollectionId !== embeddingSetId ||
        graph.settings.paused
      ) {
        throw new TransitionError('Selected collection changed during import publication.');
      }
      assertCurrent(graph);
      return { kind: 'complete' };
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
