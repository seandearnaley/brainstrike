import {
  runWorkspaceIndexStageBenchmark,
  type WorkspaceIndexStageBenchmarkMode,
  type WorkspaceIndexStageBenchmarkRequest,
  type WorkspaceIndexStageBenchmarkResult,
} from './workspace-index-debug-benchmark';

type StageDependencies = Omit<Parameters<typeof runWorkspaceIndexStageBenchmark>[0], 'request'>;

export interface WorkspaceIndexStageApi {
  readiness: (mode: WorkspaceIndexStageBenchmarkMode) => {
    readonly missingDependencies: readonly string[];
    readonly ready: boolean;
  };
  run: (
    request: WorkspaceIndexStageBenchmarkRequest
  ) => Promise<WorkspaceIndexStageBenchmarkResult>;
}

declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: Discoverable opt-in verifier surface.
    __BRAINSTRIKE_WORKSPACE_INDEX_STAGE__?: WorkspaceIndexStageApi | undefined;
  }
}

/** Component measurements have their own readiness, independent of ingestion ownership. */
export function createWorkspaceIndexStageApi(
  readDependencies: () => StageDependencies
): WorkspaceIndexStageApi {
  const readiness: WorkspaceIndexStageApi['readiness'] = (mode) => {
    const dependencies = readDependencies();
    const missingDependencies: string[] = [];
    if (
      (mode === 'db-completion-ceiling' || mode === 'import-ceiling') &&
      !(dependencies.db?.transaction || dependencies.electronRunTransaction)
    ) {
      missingDependencies.push('transactional database');
    }
    if (mode === 'import-ceiling' && !dependencies.applyManagedCacheBatch) {
      missingDependencies.push('managed-cache apply');
    }
    if (mode === 'chunking-ceiling' && !dependencies.chunkingHost?.chunkBatch) {
      missingDependencies.push('hidden chunking host');
    }
    if (
      mode === 'embedding-ceiling' &&
      !(dependencies.embeddingHost?.queryEmbedding && dependencies.embeddingHost.getStatus)
    ) {
      missingDependencies.push('hidden embedding host');
    }
    if (mode === 'integrated') {
      missingDependencies.push('implemented component mode');
    }
    return { missingDependencies, ready: missingDependencies.length === 0 };
  };
  return Object.freeze({
    readiness,
    run: async (request: WorkspaceIndexStageBenchmarkRequest) => {
      const state = readiness(request.mode);
      if (!state.ready) {
        throw new Error(
          `Workspace Index stage benchmark requires ${state.missingDependencies.join(', ')}.`
        );
      }
      return await runWorkspaceIndexStageBenchmark({ ...readDependencies(), request });
    },
  });
}
