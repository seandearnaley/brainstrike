/**
 * System Diagnostics Tool
 *
 * Platform-agnostic tool for checking system health across different components.
 * Uses dependency injection for cross-platform compatibility.
 *
 * @see retrieval-tool.ts for the DI pattern reference
 */

import type { SystemDiagnosticsInput } from './schemas';
import { SystemDiagnosticsInputSchema } from './schemas';

/** Tool identifier used in the Mastra tools registry */
export const SYSTEM_DIAGNOSTICS_TOOL_ID = 'brainstrike.systemDiagnostics' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const DIAGNOSTICS_ERROR_MESSAGES = {
  checkFailed: 'Failed to run diagnostics. Please try again.',
  categoryUnavailable: 'The requested diagnostic category is not available.',
} as const;

export const SAFE_DIAGNOSTICS_ERRORS = new Set<string>(Object.values(DIAGNOSTICS_ERROR_MESSAGES));

/**
 * Health status levels.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/**
 * Individual component health result.
 */
export interface ComponentHealth {
  /** Component name */
  name: string;
  /** Health status */
  status: HealthStatus;
  /** Human-readable message */
  message: string;
  /** Additional metrics */
  metrics?: Record<string, number | string>;
  /** Error details if unhealthy */
  error?: string;
  /** Last check timestamp */
  checkedAt: string;
}

/**
 * Database diagnostics.
 */
export interface DatabaseDiagnostics {
  /** Overall database health */
  status: HealthStatus;
  /** Connection status */
  connected: boolean;
  /** Table counts */
  tables: {
    fileRecords: number;
    chunks: number;
    embeddings: number;
    embeddingSets: number;
  };
  /** Database size in bytes */
  sizeBytes: number;
  /** Recent migrations */
  lastMigration?: string;
}

/**
 * Queue diagnostics.
 */
export interface QueueDiagnostics {
  /** Overall queue health */
  status: HealthStatus;
  /** Durable queue (job persistence) */
  durableQueue: {
    queued: number;
    running: number;
    failed: number;
    succeeded: number;
  };
  /** Ephemeral queue (in-memory) */
  ephemeralQueue: {
    pending: number;
    processing: number;
  };
  /** Jobs per minute throughput */
  throughput: number;
  /** Recent errors */
  recentErrors: string[];
}

/**
 * Worker diagnostics.
 */
export interface WorkerDiagnostics {
  /** Overall worker health */
  status: HealthStatus;
  /** Whether workers are running */
  isRunning: boolean;
  /** Active worker count */
  activeWorkers: number;
  /** Processing statistics */
  stats: {
    chunksProcessed: number;
    embeddingsGenerated: number;
    averageLatencyMs: number;
  };
  /** Last activity timestamp */
  lastActivityAt?: string;
}

/**
 * Storage diagnostics.
 */
export interface StorageDiagnostics {
  /** Overall storage health */
  status: HealthStatus;
  /** Storage type */
  type: string;
  /** Available space in bytes (null if unknown) */
  availableBytes: number | null;
  /** Used space in bytes */
  usedBytes: number;
  /** Whether storage is writable */
  isWritable: boolean;
}

/**
 * Result returned by the diagnostics tool.
 */
export interface SystemDiagnosticsToolResult {
  /** Overall system health */
  overallStatus: HealthStatus;
  /** Categories that were checked */
  categoriesChecked: string[];
  /** Timestamp of the diagnostic run */
  timestamp: string;
  /** Database diagnostics (if requested) */
  database?: DatabaseDiagnostics;
  /** Queue diagnostics (if requested) */
  queue?: QueueDiagnostics;
  /** Worker diagnostics (if requested) */
  worker?: WorkerDiagnostics;
  /** Storage diagnostics (if requested) */
  storage?: StorageDiagnostics;
  /** Human-readable summary */
  summary: string;
  /** Specific issues found */
  issues: string[];
}

/**
 * Dependencies required by the diagnostics tool.
 * Platform-specific implementations provide these callbacks.
 */
export interface DiagnosticsToolDependencies {
  /**
   * Gets database diagnostics.
   */
  getDatabaseHealth?: () => Promise<DatabaseDiagnostics>;

  /**
   * Gets queue diagnostics.
   */
  getQueueHealth?: () => Promise<QueueDiagnostics>;

  /**
   * Gets worker diagnostics.
   */
  getWorkerHealth?: () => Promise<WorkerDiagnostics>;

  /**
   * Gets storage diagnostics.
   */
  getStorageHealth?: () => Promise<StorageDiagnostics>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Context type for Mastra tool execution.
 */
interface ToolContext<TInput> {
  context: TInput;
}

/**
 * Handles errors from diagnostics operations.
 */
function handleError(error: unknown, logger?: DiagnosticsToolDependencies['logger']): never {
  const message = error instanceof Error ? error.message : DIAGNOSTICS_ERROR_MESSAGES.checkFailed;

  if (SAFE_DIAGNOSTICS_ERRORS.has(message)) {
    throw new Error(message);
  }

  logger?.error('Diagnostics check failed', { error });
  throw new Error(DIAGNOSTICS_ERROR_MESSAGES.checkFailed);
}

/**
 * Compute overall status from individual component statuses.
 */
function computeOverallStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.length === 0) {
    return 'unknown';
  }
  if (statuses.some((s) => s === 'unhealthy')) {
    return 'unhealthy';
  }
  if (statuses.some((s) => s === 'degraded')) {
    return 'degraded';
  }
  if (statuses.every((s) => s === 'healthy')) {
    return 'healthy';
  }
  return 'unknown';
}

/** Extract database issues */
function getDatabaseIssues(database: DatabaseDiagnostics): string[] {
  const issues: string[] = [];
  if (database.status === 'unhealthy' || !database.connected) {
    issues.push('Database connection issue detected');
  }
  return issues;
}

/** Extract queue issues */
function getQueueIssues(queue: QueueDiagnostics): string[] {
  const issues: string[] = [];
  if (queue.durableQueue.failed > 0) {
    issues.push(`${queue.durableQueue.failed} failed jobs in queue`);
  }
  if (queue.recentErrors.length > 0) {
    issues.push(`Queue errors: ${queue.recentErrors[0]}`);
  }
  return issues;
}

/** Extract worker issues */
function getWorkerIssues(worker: WorkerDiagnostics): string[] {
  const issues: string[] = [];
  if (!worker.isRunning) {
    issues.push('Embedding workers are not running');
  }
  if (worker.activeWorkers === 0 && worker.isRunning) {
    issues.push('No active workers despite system running');
  }
  return issues;
}

/** Extract storage issues */
function getStorageIssues(storage: StorageDiagnostics): string[] {
  const issues: string[] = [];
  if (!storage.isWritable) {
    issues.push('Storage is read-only');
  }
  if (storage.availableBytes !== null && storage.availableBytes < 100 * 1024 * 1024) {
    issues.push('Low storage space (< 100MB available)');
  }
  return issues;
}

/**
 * Generate a human-readable summary and find issues.
 */
function generateSummaryAndIssues(
  database?: DatabaseDiagnostics,
  queue?: QueueDiagnostics,
  worker?: WorkerDiagnostics,
  storage?: StorageDiagnostics
): { summary: string; issues: string[] } {
  const issues: string[] = [];
  const statusParts: string[] = [];

  if (database) {
    statusParts.push(`DB: ${database.status}`);
    issues.push(...getDatabaseIssues(database));
  }

  if (queue) {
    statusParts.push(`Queue: ${queue.status}`);
    issues.push(...getQueueIssues(queue));
  }

  if (worker) {
    statusParts.push(`Workers: ${worker.status}`);
    issues.push(...getWorkerIssues(worker));
  }

  if (storage) {
    statusParts.push(`Storage: ${storage.status}`);
    issues.push(...getStorageIssues(storage));
  }

  const summary = statusParts.length > 0 ? statusParts.join(' | ') : 'No diagnostics available';

  return { summary, issues };
}

/** Generic health check with fallback */
async function checkHealthWithFallback<T extends { status: HealthStatus }>(
  getter: () => Promise<T>,
  fallback: T
): Promise<{ data: T; status: HealthStatus }> {
  try {
    const data = await getter();
    return { data, status: data.status };
  } catch {
    return { data: fallback, status: fallback.status };
  }
}

/** Default fallback data for each diagnostic category */
const FALLBACK_DATABASE: DatabaseDiagnostics = {
  status: 'unhealthy',
  connected: false,
  tables: { fileRecords: 0, chunks: 0, embeddings: 0, embeddingSets: 0 },
  sizeBytes: 0,
};

const FALLBACK_QUEUE: QueueDiagnostics = {
  status: 'unhealthy',
  durableQueue: { queued: 0, running: 0, failed: 0, succeeded: 0 },
  ephemeralQueue: { pending: 0, processing: 0 },
  throughput: 0,
  recentErrors: ['Failed to get queue status'],
};

const FALLBACK_WORKER: WorkerDiagnostics = {
  status: 'unknown',
  isRunning: false,
  activeWorkers: 0,
  stats: { chunksProcessed: 0, embeddingsGenerated: 0, averageLatencyMs: 0 },
};

const FALLBACK_STORAGE: StorageDiagnostics = {
  status: 'unknown',
  type: 'unknown',
  availableBytes: null,
  usedBytes: 0,
  isWritable: false,
};

/** Check if a category should be checked */
function shouldCheck(category: string, categories: string[], checkAll: boolean): boolean {
  return checkAll || categories.includes(category);
}

/**
 * Core diagnostics execution logic.
 */
async function runSystemDiagnostics(
  input: SystemDiagnosticsInput,
  deps: DiagnosticsToolDependencies
): Promise<SystemDiagnosticsToolResult> {
  const categories = input.categories ?? ['all'];
  const checkAll = categories.includes('all');

  deps.logger?.debug('Running system diagnostics', { categories });

  const categoriesChecked: string[] = [];
  const statuses: HealthStatus[] = [];

  let database: DatabaseDiagnostics | undefined;
  let queue: QueueDiagnostics | undefined;
  let worker: WorkerDiagnostics | undefined;
  let storage: StorageDiagnostics | undefined;

  if (shouldCheck('database', categories, checkAll) && deps.getDatabaseHealth) {
    const result = await checkHealthWithFallback(deps.getDatabaseHealth, FALLBACK_DATABASE);
    database = result.data;
    categoriesChecked.push('database');
    statuses.push(result.status);
  }

  if (shouldCheck('queue', categories, checkAll) && deps.getQueueHealth) {
    const result = await checkHealthWithFallback(deps.getQueueHealth, FALLBACK_QUEUE);
    queue = result.data;
    categoriesChecked.push('queue');
    statuses.push(result.status);
  }

  if (shouldCheck('worker', categories, checkAll) && deps.getWorkerHealth) {
    const result = await checkHealthWithFallback(deps.getWorkerHealth, FALLBACK_WORKER);
    worker = result.data;
    categoriesChecked.push('worker');
    statuses.push(result.status);
  }

  if (shouldCheck('storage', categories, checkAll) && deps.getStorageHealth) {
    const result = await checkHealthWithFallback(deps.getStorageHealth, FALLBACK_STORAGE);
    storage = result.data;
    categoriesChecked.push('storage');
    statuses.push(result.status);
  }

  const overallStatus = computeOverallStatus(statuses);
  const { summary, issues } = generateSummaryAndIssues(database, queue, worker, storage);

  deps.logger?.debug('Diagnostics complete', {
    overallStatus,
    categoriesChecked,
    issueCount: issues.length,
  });

  // Build result with only defined properties (exactOptionalPropertyTypes compliance)
  const result: SystemDiagnosticsToolResult = {
    overallStatus,
    categoriesChecked,
    timestamp: new Date().toISOString(),
    summary,
    issues,
  };

  if (database !== undefined) {
    result.database = database;
  }
  if (queue !== undefined) {
    result.queue = queue;
  }
  if (worker !== undefined) {
    result.worker = worker;
  }
  if (storage !== undefined) {
    result.storage = storage;
  }

  return result;
}

/**
 * Mastra tool type.
 */
interface MastraTool {
  id: string;
  description: string;
  inputSchema: typeof SystemDiagnosticsInputSchema;
  execute: (context: ToolContext<SystemDiagnosticsInput>) => Promise<SystemDiagnosticsToolResult>;
}

/**
 * Creates a Mastra-compatible system diagnostics tool.
 *
 * @example
 * ```typescript
 * const tool = createSystemDiagnosticsTool({
 *   getDatabaseHealth: async () => diagnosticStore.getDatabaseHealth(),
 *   getQueueHealth: async () => diagnosticStore.getQueueHealth(),
 * });
 * ```
 */
export function createSystemDiagnosticsTool(deps: DiagnosticsToolDependencies): MastraTool {
  return {
    id: SYSTEM_DIAGNOSTICS_TOOL_ID,
    description:
      'Run system diagnostics to check database, queue, worker, and storage health. ' +
      'Identifies issues and provides metrics for troubleshooting.',
    inputSchema: SystemDiagnosticsInputSchema,
    execute: async (context: ToolContext<SystemDiagnosticsInput>) => {
      try {
        return await runSystemDiagnostics(context.context, deps);
      } catch (error) {
        handleError(error, deps.logger);
      }
    },
  };
}

/**
 * Type for tools input (matching Mastra pattern).
 */
export type ToolsInput = Record<string, MastraTool>;

/**
 * Builds a tools object with the diagnostics tool added to a base set.
 */
export function buildToolsWithDiagnostics(
  deps: DiagnosticsToolDependencies,
  base: ToolsInput = {}
): ToolsInput {
  return {
    ...base,
    [SYSTEM_DIAGNOSTICS_TOOL_ID]: createSystemDiagnosticsTool(deps),
  };
}
