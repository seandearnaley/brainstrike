import {
  type BrainstrikeDbWorkOptions,
  createTursoJobQueueReadModel,
  JobQueue,
  useModelRegistryDbClient,
  useOptionalProfileBootstrapReport,
} from '@brainstrike/db';
import { useMemo } from 'react';

export interface EmbeddingJobQueue {
  readonly getQueueStats: (
    queue?: string,
    options?: BrainstrikeDbWorkOptions
  ) => ReturnType<JobQueue['getQueueStats']>;
}

export type EmbeddingJobQueueRetryActions = Pick<
  JobQueue,
  'repairUnclaimableQueued' | 'requeueFailed'
>;

export type EmbeddingJobQueueWithRetryActions = EmbeddingJobQueue & EmbeddingJobQueueRetryActions;

export function hasEmbeddingJobQueueRetryActions(
  jobQueue: EmbeddingJobQueue | null
): jobQueue is EmbeddingJobQueueWithRetryActions {
  const candidate = jobQueue as Partial<EmbeddingJobQueueRetryActions> | null;
  return (
    typeof candidate?.repairUnclaimableQueued === 'function' &&
    typeof candidate.requeueFailed === 'function'
  );
}

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
      return createTursoJobQueueReadModel(db);
    }
    return null;
  }, [db, engine, ready]);
}
