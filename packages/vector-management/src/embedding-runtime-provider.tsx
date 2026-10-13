import { useVectorPreferencesStore } from '@brainstrike/app-state/stores/vector-preferences-store';
import { JobQueue } from '@brainstrike/db';
import { useFileChunkRepository, usePGliteDatabase } from '@brainstrike/db/react';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import {
  type EmbeddingRuntimeController,
  useEmbeddingRuntimeController,
} from './vector-status/embedding-runtime-controller';
import {
  createVectorQueueService,
  type VectorQueueService,
} from './vector-status/vector-queue-service';

interface EmbeddingCoverageRepository {
  clearEmbeddingsForSet: (embeddingSetId: string) => Promise<number>;
  getCoverageForSet: (
    setId: string
  ) => Promise<{ chunksWithEmbeddingsForSet: number; totalChunks: number }>;
}

interface EmbeddingRuntimeContextValue {
  controller: EmbeddingRuntimeController;
  service: VectorQueueService | null;
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

export function EmbeddingRuntimeProvider({
  children,
  databaseEnabled = true,
}: {
  children: ReactNode;
  databaseEnabled?: boolean;
}) {
  const db = usePGliteDatabase({ enabled: databaseEnabled });
  const chunkRepository = useFileChunkRepository({ enabled: databaseEnabled });
  const devicePreference = useVectorPreferencesStore((state) => state.devicePref);
  const reinitEveryN = useVectorPreferencesStore((state) => state.reinitEveryN);

  const coverageRepository = useMemo(
    () => toEmbeddingCoverageRepository(chunkRepository),
    [chunkRepository]
  );

  const service = useMemo(() => {
    if (!(db && coverageRepository)) {
      return null;
    }
    return createVectorQueueService({
      chunkRepository: coverageRepository,
      db,
      jobQueue: new JobQueue(db),
    });
  }, [coverageRepository, db]);

  const controller = useEmbeddingRuntimeController({
    db,
    devicePreference,
    reinitEveryN,
    service,
  });

  const value = useMemo<EmbeddingRuntimeContextValue>(
    () => ({
      controller,
      service,
    }),
    [controller, service]
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
