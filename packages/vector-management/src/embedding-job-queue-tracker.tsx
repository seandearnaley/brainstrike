import { JobQueue, usePGliteDatabase } from '@brainstrike/db';
import { isAppActive } from '@brainstrike/hooks';
import type { QueueStatsSnapshot } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useMemo, useRef } from 'react';

const logger = createLogger('EmbeddingJobQueueTracker');
const EMBEDDINGS_QUEUE_NAME = 'embeddings';
const JOB_QUEUE_POLL_MS = 1500;
const JOB_QUEUE_CLEAR_DELAY_MS = 1500;

export interface EmbeddingJobQueueTrackerProps {
  readonly intervalMs?: number;
}

/**
 * BST-359: Single poller for durable queue stats. Writes full stats to the
 * Zustand store so QueueHud, diagnostics panel, and status popover can read
 * without running their own polling intervals.
 */
export function EmbeddingJobQueueTracker({
  intervalMs = JOB_QUEUE_POLL_MS,
}: EmbeddingJobQueueTrackerProps): null {
  const db = usePGliteDatabase();
  const jobQueue = useMemo(() => (db ? new JobQueue(db) : null), [db]);
  const setIsJobQueueActive = useVectorStatusUIStore((s) => s.setIsJobQueueActive);
  const setDurableQueueStats = useVectorStatusUIStore((s) => s.setDurableQueueStats);
  const jobQueueActiveRef = useRef(false);
  const jobQueueClearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobQueuePollInFlightRef = useRef(false);

  useEffect(() => {
    if (!jobQueue) {
      jobQueueActiveRef.current = false;
      if (jobQueueClearTimeoutRef.current) {
        clearTimeout(jobQueueClearTimeoutRef.current);
        jobQueueClearTimeoutRef.current = null;
      }
      setIsJobQueueActive(false);
      setDurableQueueStats(null);
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

    const fetchStats = async (): Promise<QueueStatsSnapshot | null> => {
      const rows = await jobQueue.getQueueStats(EMBEDDINGS_QUEUE_NAME);
      const s = rows?.[0];
      if (!s) {
        return { queued: 0, running: 0, failed: 0, succeeded: 0, nextRunnableAt: null };
      }
      return {
        queued: s.queued,
        running: s.running,
        failed: s.failed,
        succeeded: s.succeeded,
        nextRunnableAt: s.nextRunnableAt ?? null,
      };
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
      const stats = await fetchStats();
      if (cancelled) {
        return;
      }
      setDurableQueueStats(stats);
      const isActive = stats ? stats.queued > 0 || stats.running > 0 : false;
      updateJobQueueActive(isActive);
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
      if (!isAppActive()) {
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
      setDurableQueueStats(null);
    };
  }, [jobQueue, intervalMs, setIsJobQueueActive, setDurableQueueStats]);

  return null;
}
