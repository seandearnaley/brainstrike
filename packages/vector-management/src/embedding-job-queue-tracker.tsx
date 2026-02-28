import { usePGliteDatabase } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useRef } from 'react';

const logger = createLogger('EmbeddingJobQueueTracker');
const EMBEDDINGS_QUEUE_NAME = 'embeddings';
const JOB_QUEUE_POLL_MS = 1500;
const JOB_QUEUE_CLEAR_DELAY_MS = 1500;
const JOB_QUEUE_ACTIVE_QUERY = `
  SELECT COUNT(*)::int AS active
    FROM job_queue
   WHERE queue = $1
     AND state IN ('queued', 'running')
`.trim();

export interface EmbeddingJobQueueTrackerProps {
  readonly intervalMs?: number;
}

export function EmbeddingJobQueueTracker({
  intervalMs = JOB_QUEUE_POLL_MS,
}: EmbeddingJobQueueTrackerProps): null {
  const db = usePGliteDatabase();
  const setIsJobQueueActive = useVectorStatusUIStore((s) => s.setIsJobQueueActive);
  const jobQueueActiveRef = useRef(false);
  const jobQueueClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobQueuePollInFlightRef = useRef(false);

  useEffect(() => {
    if (!db) {
      jobQueueActiveRef.current = false;
      if (jobQueueClearTimeoutRef.current) {
        clearTimeout(jobQueueClearTimeoutRef.current);
        jobQueueClearTimeoutRef.current = null;
      }
      setIsJobQueueActive(false);
      return;
    }

    let cancelled = false;

    const clearPendingClear = () => {
      if (!jobQueueClearTimeoutRef.current) {
        return;
      }
      clearTimeout(jobQueueClearTimeoutRef.current);
      jobQueueClearTimeoutRef.current = null;
    };

    const markQueueActive = () => {
      if (jobQueueActiveRef.current) {
        return;
      }
      jobQueueActiveRef.current = true;
      setIsJobQueueActive(true);
    };

    const scheduleQueueClear = () => {
      if (!jobQueueActiveRef.current) {
        return;
      }
      clearPendingClear();
      jobQueueClearTimeoutRef.current = setTimeout(() => {
        jobQueueActiveRef.current = false;
        setIsJobQueueActive(false);
        jobQueueClearTimeoutRef.current = null;
      }, JOB_QUEUE_CLEAR_DELAY_MS);
    };

    const updateJobQueueActive = (isActive: boolean) => {
      if (isActive) {
        clearPendingClear();
        markQueueActive();
        return;
      }
      scheduleQueueClear();
    };

    const fetchActiveCount = async (): Promise<number> => {
      const result = await db.query<{ active: number | string }>(JOB_QUEUE_ACTIVE_QUERY, [
        EMBEDDINGS_QUEUE_NAME,
      ]);
      return Number(result.rows[0]?.active ?? 0);
    };

    const handlePollError = (error: unknown) => {
      if (cancelled) {
        return;
      }
      logger.debug('Failed to poll embedding job queue', {
        error: error instanceof Error ? error.message : String(error),
      });
    };

    const runPoll = async () => {
      const activeCount = await fetchActiveCount();
      if (cancelled) {
        return;
      }
      updateJobQueueActive(activeCount > 0);
    };

    const safeRunPoll = async () => {
      try {
        await runPoll();
      } catch (error) {
        handlePollError(error);
      }
    };

    const pollJobQueue = async () => {
      if (jobQueuePollInFlightRef.current || cancelled) {
        return;
      }
      jobQueuePollInFlightRef.current = true;
      await safeRunPoll();
      jobQueuePollInFlightRef.current = false;
    };

    void pollJobQueue();
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
        return;
      }
      void pollJobQueue();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (jobQueueClearTimeoutRef.current) {
        clearTimeout(jobQueueClearTimeoutRef.current);
        jobQueueClearTimeoutRef.current = null;
      }
      jobQueueActiveRef.current = false;
      setIsJobQueueActive(false);
    };
  }, [db, intervalMs, setIsJobQueueActive]);

  return null;
}
