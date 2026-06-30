import {
  createTursoJobQueueReadModel,
  JobQueue,
  useFileChunkRepository,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  type EmbeddingRuntimeController,
  useEmbeddingRuntimeController,
} from './vector-status/embedding-runtime-controller';
import { createTursoVectorQueueSnapshotReader } from './vector-status/turso-vector-queue-metrics-repository';
import {
  createVectorQueueServiceForRuntime,
  type VectorQueueService,
  type VectorQueueServiceUnavailableReason,
  type VectorQueueSnapshotReader,
} from './vector-status/vector-queue-service';

interface EmbeddingCoverageRepository {
  clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  getCoverageForSet: (
    setId: string
  ) => Promise<{ chunksWithEmbeddingsForSet: number; totalChunks: number }>;
}

interface EmbeddingRuntimeContextValue {
  controller: EmbeddingRuntimeController;
  liveQueryMetricsEnabled: boolean;
  service: VectorQueueService | null;
  serviceUnavailableReason: VectorQueueServiceUnavailableReason | null;
  snapshotReader: VectorQueueSnapshotReader | null;
}

const EmbeddingRuntimeContext = createContext<EmbeddingRuntimeContextValue | null>(null);

function toEmbeddingCoverageRepository(
  repository: ReturnType<typeof useFileChunkRepository>
): EmbeddingCoverageRepository | null {
  if (repository && 'getCoverageForSet' in repository && 'clearEmbeddingsForSet' in repository) {
    return repository as EmbeddingCoverageRepository;
  }
  return null;
}

function createUnavailableTursoVectorQueueService(): VectorQueueService | null {
  return null;
}

export function EmbeddingRuntimeProvider({ children }: { children: ReactNode }) {
  const db = useModelRegistryDbClient();
  const bootstrapReport = useOptionalProfileBootstrapReport();
  const runtimeEngine = bootstrapReport?.runtime.engine ?? 'unknown';
  const chunkRepository = useFileChunkRepository();
  const devicePreference = useVectorPreferencesStore((state) => state.devicePref);
  const reinitEveryN = useVectorPreferencesStore((state) => state.reinitEveryN);

  const coverageRepository = useMemo(
    () => toEmbeddingCoverageRepository(chunkRepository),
    [chunkRepository]
  );

  const serviceResolution = useMemo(
    () =>
      createVectorQueueServiceForRuntime({
        db,
        chunkRepository: coverageRepository,
        createPGliteJobQueue: (queueDb) => new JobQueue(queueDb),
        createTursoVectorQueueService: createUnavailableTursoVectorQueueService,
        runtimeEngine,
      }),
    [coverageRepository, db, runtimeEngine]
  );
  const service = serviceResolution.service;
  const serviceUnavailableReason = serviceResolution.available ? null : serviceResolution.reason;
  const snapshotReader = useMemo(() => {
    if (service) {
      return service;
    }
    if (!(runtimeEngine === 'turso' && db && coverageRepository)) {
      return null;
    }
    const jobQueue = createTursoJobQueueReadModel(db);
    return createTursoVectorQueueSnapshotReader({
      chunkRepository: coverageRepository,
      jobQueue,
    });
  }, [coverageRepository, db, runtimeEngine, service]);
  const controllerDb = runtimeEngine === 'pglite' ? db : null;
  const liveQueryMetricsEnabled = runtimeEngine === 'pglite' && Boolean(service);

  const controller = useEmbeddingRuntimeController({
    db: controllerDb,
    devicePreference,
    reinitEveryN,
    service,
  });

  const value = useMemo<EmbeddingRuntimeContextValue>(
    () => ({
      controller,
      liveQueryMetricsEnabled,
      service,
      serviceUnavailableReason,
      snapshotReader,
    }),
    [controller, liveQueryMetricsEnabled, service, serviceUnavailableReason, snapshotReader]
  );

  return (
    <EmbeddingRuntimeContext.Provider value={value}>{children}</EmbeddingRuntimeContext.Provider>
  );
}

export function useSharedEmbeddingRuntime(): EmbeddingRuntimeContextValue {
  const context = useContext(EmbeddingRuntimeContext);
  if (!context) {
    throw new Error(
      'EmbeddingRuntimeProvider is required before using the shared embedding runtime.'
    );
  }
  return context;
}
