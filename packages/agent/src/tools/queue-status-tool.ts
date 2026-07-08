/**
 * Queue Status Tool
 *
 * Platform-agnostic tool for checking embedding queue status and coverage.
 * Uses dependency injection for cross-platform compatibility.
 *
 * @see retrieval-tool.ts for the DI pattern reference
 */

import type { QueueStatusInput } from './schemas';
import { QueueStatusInputSchema } from './schemas';
import { handleToolError, type ToolContext } from './types';

/** Tool identifier used in the Mastra tools registry */
export const QUEUE_STATUS_TOOL_ID = 'brainstrike.queueStatus' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const QUEUE_STATUS_ERROR_MESSAGES = {
  embeddingSetNotFound: 'The specified embedding set was not found.',
  fetchFailed: 'Failed to fetch queue status. Please try again.',
} as const;

export const SAFE_QUEUE_STATUS_ERRORS = new Set<string>(Object.values(QUEUE_STATUS_ERROR_MESSAGES));

/**
 * Coverage statistics for an embedding set.
 */
export interface CoverageStats {
  /** Coverage percentage (0-100) */
  coveragePercent: number;
  /** Total number of chunks in the database */
  total: number;
  /** Number of chunks with embeddings for the active set */
  withEmbeddings: number;
}

/**
 * Queue counts across different states.
 */
export interface QueueCounts {
  /** Jobs that failed */
  failed: number;
  /** Jobs waiting to be processed */
  queued: number;
  /** Jobs currently being processed */
  running: number;
  /** Jobs that completed successfully */
  succeeded: number;
}

/**
 * Latency statistics for job processing.
 */
export interface LatencyStats {
  /** Average latency in milliseconds */
  avgMs: number;
  /** 50th percentile latency */
  p50Ms: number;
  /** 95th percentile latency */
  p95Ms: number;
}

/**
 * Result returned by the queue status tool.
 */
export interface QueueStatusToolResult {
  /** Coverage statistics (null if no active set) */
  coverage: CoverageStats | null;
  /** Embedding set ID if filtered */
  embeddingSetId: string | null;
  /** Whether the queue is actively processing */
  isProcessing: boolean;
  /** Most recent error message (null if no errors) */
  lastError: string | null;
  /** Latency statistics */
  latency: LatencyStats;
  /** Current queue counts */
  queueCounts: QueueCounts;
  /** Human-readable status summary */
  statusSummary: string;
  /** Jobs processed per minute */
  throughput: number;
}

/**
 * Snapshot from the queue service.
 */
export interface VectorQueueSnapshot {
  coverage: {
    total: number;
    withSet: number;
  } | null;
  lastError: string | null;
  latency: LatencyStats;
  queueCounts: QueueCounts;
  throughput: number;
}

/**
 * Dependencies required by the queue status tool.
 * Platform-specific implementations provide these callbacks.
 */
export interface QueueStatusToolDependencies {
  /**
   * Optional: Gets the name of an embedding set for display.
   */
  getEmbeddingSetName?: (embeddingSetId: string) => Promise<string | undefined>;
  /**
   * Gets the current queue snapshot.
   */
  getQueueSnapshot: (embeddingSetId: string | null) => Promise<VectorQueueSnapshot>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Generate a human-readable status summary.
 */
function generateStatusSummary(
  coverage: CoverageStats | null,
  queueCounts: QueueCounts,
  throughput: number,
  lastError: string | null
): string {
  const parts: string[] = [];

  // Coverage status
  if (coverage) {
    if (coverage.coveragePercent >= 100) {
      parts.push('All chunks embedded');
    } else if (coverage.coveragePercent > 0) {
      parts.push(
        `${coverage.coveragePercent.toFixed(1)}% coverage (${coverage.withEmbeddings}/${coverage.total})`
      );
    } else {
      parts.push('No embeddings yet');
    }
  }

  // Queue activity
  const activeJobs = queueCounts.queued + queueCounts.running;
  if (activeJobs > 0) {
    parts.push(`${activeJobs} jobs pending`);
    if (throughput > 0) {
      parts.push(`${throughput}/min throughput`);
    }
  } else if (queueCounts.succeeded > 0) {
    parts.push('Queue idle');
  }

  // Error status
  if (queueCounts.failed > 0) {
    parts.push(`${queueCounts.failed} failed jobs`);
  }

  if (lastError) {
    parts.push(`Last error: ${lastError.slice(0, 50)}...`);
  }

  return parts.length > 0 ? parts.join('. ') : 'No activity';
}

/**
 * Core queue status execution logic.
 */
async function runQueueStatus(
  input: QueueStatusInput,
  deps: QueueStatusToolDependencies
): Promise<QueueStatusToolResult> {
  const embeddingSetId = input.embeddingSetId ?? null;

  deps.logger?.debug('Fetching queue status', { embeddingSetId });

  const snapshot = await deps.getQueueSnapshot(embeddingSetId);

  // Transform coverage data
  const coverage: CoverageStats | null = snapshot.coverage
    ? {
        coveragePercent:
          snapshot.coverage.total > 0
            ? (snapshot.coverage.withSet / snapshot.coverage.total) * 100
            : 0,
        total: snapshot.coverage.total,
        withEmbeddings: snapshot.coverage.withSet,
      }
    : null;

  const isProcessing = snapshot.queueCounts.queued > 0 || snapshot.queueCounts.running > 0;

  const statusSummary = generateStatusSummary(
    coverage,
    snapshot.queueCounts,
    snapshot.throughput,
    snapshot.lastError
  );

  deps.logger?.debug('Queue status fetched', {
    coverage: coverage?.coveragePercent,
    embeddingSetId,
    isProcessing,
  });

  return {
    coverage,
    embeddingSetId,
    isProcessing,
    lastError: snapshot.lastError,
    latency: snapshot.latency,
    queueCounts: snapshot.queueCounts,
    statusSummary,
    throughput: snapshot.throughput,
  };
}

/**
 * Mastra tool type.
 */
interface MastraTool {
  description: string;
  execute: (context: ToolContext<QueueStatusInput>) => Promise<QueueStatusToolResult>;
  id: string;
  inputSchema: typeof QueueStatusInputSchema;
}

/**
 * Creates a Mastra-compatible queue status tool with the provided dependencies.
 *
 * @example
 * ```typescript
 * const tool = createQueueStatusTool({
 *   getQueueSnapshot: async (setId) => vectorQueueService.refresh(setId),
 * });
 * ```
 */
export function createQueueStatusTool(deps: QueueStatusToolDependencies): MastraTool {
  return {
    description:
      'Check embedding queue status, coverage statistics, and processing health. ' +
      'Shows how many chunks are embedded, queue activity, and any errors.',
    execute: async (context: ToolContext<QueueStatusInput>) => {
      try {
        return await runQueueStatus(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_QUEUE_STATUS_ERRORS,
          QUEUE_STATUS_ERROR_MESSAGES.fetchFailed,
          deps.logger
        );
      }
    },
    id: QUEUE_STATUS_TOOL_ID,
    inputSchema: QueueStatusInputSchema,
  };
}

/**
 * Type for tools input (matching Mastra pattern).
 */
export type ToolsInput = Record<string, MastraTool>;

/**
 * Builds a tools object with the queue status tool added to a base set.
 */
export function buildToolsWithQueueStatus(
  deps: QueueStatusToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [QUEUE_STATUS_TOOL_ID]: createQueueStatusTool(deps),
  };
}
