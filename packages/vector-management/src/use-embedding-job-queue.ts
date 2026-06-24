import {
  extractDbExecutionClient,
  type IDatabase,
  JobQueue,
  TursoJobQueue,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { useMemo } from 'react';

export type EmbeddingJobQueue = Pick<
  JobQueue | TursoJobQueue,
  'clear' | 'getQueueStats' | 'repairUnclaimableQueued' | 'requeueFailed'
>;

export function useEmbeddingJobQueue(): EmbeddingJobQueue | null {
  const db = useModelRegistryDbClient();
  const report = useOptionalProfileBootstrapReport();
  const engine = report?.runtime.engine ?? null;
  const ready = report?.ready === true;

  return useMemo(() => {
    if (!(db && ready)) {
      return null;
    }
    if (engine === 'pglite') {
      return new JobQueue(db as IDatabase);
    }
    if (engine === 'turso') {
      const executionClient = extractDbExecutionClient(db);
      return executionClient ? new TursoJobQueue(executionClient) : null;
    }
    return null;
  }, [db, engine, ready]);
}
