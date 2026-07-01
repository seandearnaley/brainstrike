import {
  type BrainstrikeDbWorkOptions,
  extractDbExecutionClient,
  JobQueue,
  TursoJobQueue,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { useMemo } from 'react';

export type EmbeddingJobQueue = Pick<
  JobQueue | TursoJobQueue,
  'clear' | 'repairUnclaimableQueued' | 'requeueFailed'
> & {
  readonly getQueueStats: (
    queue?: string,
    options?: BrainstrikeDbWorkOptions
  ) => ReturnType<JobQueue['getQueueStats']>;
};

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
      return new JobQueue(db);
    }
    if (engine === 'turso') {
      const executionClient = extractDbExecutionClient(db);
      return executionClient ? new TursoJobQueue(executionClient) : null;
    }
    return null;
  }, [db, engine, ready]);
}
