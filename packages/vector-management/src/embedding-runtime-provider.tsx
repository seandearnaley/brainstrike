import {
  createTursoJobQueueReadModel,
  JobQueue,
  useBrainstrikeExecutionDbClient,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { useVectorPreferencesStore } from '@brainstrike/preferences/stores/vector-preferences-store';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  createBrowserTursoVectorQueueService,
  isBrowserTursoVectorQueueChunkRepository,
} from './vector-status/browser-turso-vector-queue-service';
import { createDesktopTursoVectorQueueService } from './vector-status/desktop-turso-vector-queue-service';
import {
  type EmbeddingRuntimeController,
  useEmbeddingRuntimeController,
} from './vector-status/embedding-runtime-controller';
import { createTursoBrowserEmbeddingWorkerStorage } from './vector-status/turso-browser-embedding-worker-storage';
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

export function EmbeddingRuntimeProvider({ children }: { children: ReactNode }) {
  const db = useModelRegistryDbClient();
  const bootstrapReport = useOptionalProfileBootstrapReport();
  const executionClient = useBrainstrikeExecutionDbClient();
  const runtimeEngine = bootstrapReport?.runtime.engine ?? 'unknown';
  const chunkRepository = useFileChunkRepository();
  const embeddingSetsRepository = useEmbeddingSetsRepository();
  const devicePreference = useVectorPreferencesStore((state) => state.devicePref);
  const reinitEveryN = useVectorPreferencesStore((state) => state.reinitEveryN);

  const coverageRepository = useMemo(
    () => toEmbeddingCoverageRepository(chunkRepository),
    [chunkRepository]
  );

  const tursoSnapshotReader = useMemo(() => {
    if (!(runtimeEngine === 'turso' && db && coverageRepository)) {
      return null;
    }
    const jobQueue = createTursoJobQueueReadModel(db);
    return createTursoVectorQueueSnapshotReader({
      chunkRepository: coverageRepository,
      jobQueue,
    });
  }, [coverageRepository, db, runtimeEngine]);

  const browserTursoRuntime =
    bootstrapReport?.runtime.engine === 'turso' && bootstrapReport.runtime.host === 'browser';

  const serviceResolution = useMemo(
    () =>
      createVectorQueueServiceForRuntime({
        db,
        chunkRepository: coverageRepository,
        createPGliteJobQueue: (queueDb) => new JobQueue(queueDb),
        createTursoVectorQueueService: ({ db: vectorQueueDb }) => {
          if (browserTursoRuntime) {
            // A7 cutover: the browser has no desktop owner IPC — compose the
            // vector queue service over the provider-owned execution client.
            // Missing pieces keep the service unavailable (fail closed with
            // the missing-turso-vector-queue-adapter diagnostics).
            if (
              !(
                executionClient &&
                embeddingSetsRepository &&
                isBrowserTursoVectorQueueChunkRepository(chunkRepository)
              )
            ) {
              return null;
            }
            return createBrowserTursoVectorQueueService({
              chunkRepository,
              db: vectorQueueDb,
              embeddingSetsRepository,
              executionClient: executionClient.db,
            });
          }
          return tursoSnapshotReader
            ? createDesktopTursoVectorQueueService({
                db: vectorQueueDb,
                snapshotReader: tursoSnapshotReader,
              })
            : null;
        },
        runtimeEngine,
      }),
    [
      browserTursoRuntime,
      chunkRepository,
      coverageRepository,
      db,
      embeddingSetsRepository,
      executionClient,
      runtimeEngine,
      tursoSnapshotReader,
    ]
  );
  const service = serviceResolution.service;
  const serviceUnavailableReason = serviceResolution.available ? null : serviceResolution.reason;
  const snapshotReader = service ?? tursoSnapshotReader;
  const controllerDb = runtimeEngine === 'pglite' ? db : null;
  const liveQueryMetricsEnabled = runtimeEngine === 'pglite' && Boolean(service);

  /**
   * Browser Turso local worker storage seam (mirrors the desktop hidden-host
   * adapter selection): a browser Turso runtime routes the local embedding
   * worker through the provider-owned WAL single-writer execution client via
   * createTursoBrowserEmbeddingWorkerStorage. The factory is lazy and runs at
   * worker start; while the bootstrap report is not ready or the execution
   * client is not exposed, it throws so the worker start fails closed with a
   * visible diagnostic (never a silent PGlite-storage fallback). PGlite
   * runtimes keep the default PGlite-backed worker storage (factory null).
   */
  const createLocalWorkerStorage = useMemo(() => {
    if (!(browserTursoRuntime && bootstrapReport)) {
      return null;
    }
    return () => {
      if (!executionClient) {
        throw new Error(
          'Browser Turso embedding worker storage requires the provider-owned execution client, ' +
            'but the DB provider has not exposed a ready Turso execution client yet. ' +
            'Failing closed — the browser Turso queue path has no PGlite fallback.'
        );
      }
      return createTursoBrowserEmbeddingWorkerStorage({
        // BrainstrikeExecutionDbClient.db is typed as an execution client
        // (capability-proven inside the hook); the adapter still re-asserts
        // execution capabilities at construction.
        client: executionClient.db,
        report: bootstrapReport,
      });
    };
  }, [bootstrapReport, browserTursoRuntime, executionClient]);

  const controller = useEmbeddingRuntimeController({
    createLocalWorkerStorage,
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
