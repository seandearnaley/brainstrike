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
import { handleToolError, type ToolContext } from './types';

/** Tool identifier used in the Mastra tools registry */
export const SYSTEM_DIAGNOSTICS_TOOL_ID = 'brainstrike.systemDiagnostics' as const;

/**
 * Safe error messages that can be shown to users.
 */
export const DIAGNOSTICS_ERROR_MESSAGES = {
  categoryUnavailable: 'The requested diagnostic category is not available.',
  checkFailed: 'Failed to run diagnostics. Please try again.',
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
  /** Last check timestamp */
  checkedAt: string;
  /** Error details if unhealthy */
  error?: string;
  /** Human-readable message */
  message: string;
  /** Additional metrics */
  metrics?: Record<string, number | string>;
  /** Component name */
  name: string;
  /** Health status */
  status: HealthStatus;
}

/**
 * Database diagnostics.
 */
export interface DatabaseDiagnostics {
  /** Connection status */
  connected: boolean;
  /** Recent migrations */
  lastMigration?: string;
  /** Database size in bytes */
  sizeBytes: number;
  /** Overall database health */
  status: HealthStatus;
  /** Table counts */
  tables: {
    fileRecords: number;
    chunks: number;
    embeddings: number;
    embeddingSets: number;
  };
}

/**
 * Queue diagnostics.
 */
export interface QueueDiagnostics {
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
  /** Recent errors */
  recentErrors: string[];
  /** Overall queue health */
  status: HealthStatus;
  /** Jobs per minute throughput */
  throughput: number;
}

/**
 * Worker diagnostics.
 */
export interface WorkerDiagnostics {
  /** Active worker count */
  activeWorkers: number;
  /** Whether workers are running */
  isRunning: boolean;
  /** Last activity timestamp */
  lastActivityAt?: string;
  /** Processing statistics */
  stats: {
    chunksProcessed: number;
    embeddingsGenerated: number;
    averageLatencyMs: number;
  };
  /** Overall worker health */
  status: HealthStatus;
}

/**
 * Storage diagnostics.
 */
export interface StorageDiagnostics {
  /** Available space in bytes (null if unknown) */
  availableBytes: number | null;
  /** Whether storage is writable */
  isWritable: boolean;
  /** Overall storage health */
  status: HealthStatus;
  /** Storage type */
  type: string;
  /** Used space in bytes */
  usedBytes: number;
}

/**
 * Result returned by the diagnostics tool.
 */
export interface SystemDiagnosticsToolResult {
  /** Categories that were checked */
  categoriesChecked: string[];
  /** Database diagnostics (if requested) */
  database?: DatabaseDiagnostics;
  /** Specific issues found */
  issues: string[];
  /** Overall system health */
  overallStatus: HealthStatus;
  /** Queue diagnostics (if requested) */
  queue?: QueueDiagnostics;
  /** Storage diagnostics (if requested) */
  storage?: StorageDiagnostics;
  /** Human-readable summary */
  summary: string;
  /** Timestamp of the diagnostic run */
  timestamp: string;
  /** Worker diagnostics (if requested) */
  worker?: WorkerDiagnostics;
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
   * Gets storage diagnostics.
   */
  getStorageHealth?: () => Promise<StorageDiagnostics>;

  /**
   * Gets worker diagnostics.
   */
  getWorkerHealth?: () => Promise<WorkerDiagnostics>;

  /**
   * Optional logger for debugging.
   */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
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

  return { issues, summary };
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
  connected: false,
  sizeBytes: 0,
  status: 'unhealthy',
  tables: { chunks: 0, embeddingSets: 0, embeddings: 0, fileRecords: 0 },
};

const FALLBACK_QUEUE: QueueDiagnostics = {
  durableQueue: { failed: 0, queued: 0, running: 0, succeeded: 0 },
  ephemeralQueue: { pending: 0, processing: 0 },
  recentErrors: ['Failed to get queue status'],
  status: 'unhealthy',
  throughput: 0,
};

const FALLBACK_WORKER: WorkerDiagnostics = {
  activeWorkers: 0,
  isRunning: false,
  stats: { averageLatencyMs: 0, chunksProcessed: 0, embeddingsGenerated: 0 },
  status: 'unknown',
};

const FALLBACK_STORAGE: StorageDiagnostics = {
  availableBytes: null,
  isWritable: false,
  status: 'unknown',
  type: 'unknown',
  usedBytes: 0,
};

/** Check if a category should be checked */
// `readonly`: the Effect-authored `SystemDiagnosticsInputSchema` decodes
// `categories` to a `readonly` array (ADR-0004, amended 2026-10-15), and this
// predicate only reads it.
function shouldCheck(category: string, categories: readonly string[], checkAll: boolean): boolean {
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

  // Run all applicable health checks in parallel
  const checks: Array<{
    category: string;
    promise: Promise<{
      data: DatabaseDiagnostics | QueueDiagnostics | WorkerDiagnostics | StorageDiagnostics;
      status: HealthStatus;
    }>;
  }> = [];

  if (shouldCheck('database', categories, checkAll) && deps.getDatabaseHealth) {
    checks.push({
      category: 'database',
      promise: checkHealthWithFallback(deps.getDatabaseHealth, FALLBACK_DATABASE),
    });
  }
  if (shouldCheck('queue', categories, checkAll) && deps.getQueueHealth) {
    checks.push({
      category: 'queue',
      promise: checkHealthWithFallback(deps.getQueueHealth, FALLBACK_QUEUE),
    });
  }
  if (shouldCheck('worker', categories, checkAll) && deps.getWorkerHealth) {
    checks.push({
      category: 'worker',
      promise: checkHealthWithFallback(deps.getWorkerHealth, FALLBACK_WORKER),
    });
  }
  if (shouldCheck('storage', categories, checkAll) && deps.getStorageHealth) {
    checks.push({
      category: 'storage',
      promise: checkHealthWithFallback(deps.getStorageHealth, FALLBACK_STORAGE),
    });
  }

  const results = await Promise.all(checks.map((c) => c.promise));

  const categoriesChecked: string[] = [];
  const statuses: HealthStatus[] = [];
  let database: DatabaseDiagnostics | undefined;
  let queue: QueueDiagnostics | undefined;
  let worker: WorkerDiagnostics | undefined;
  let storage: StorageDiagnostics | undefined;

  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    const result = results[i];
    if (!(check && result)) {
      continue;
    }
    categoriesChecked.push(check.category);
    statuses.push(result.status);
    switch (check.category) {
      case 'database':
        database = result.data as DatabaseDiagnostics;
        break;
      case 'queue':
        queue = result.data as QueueDiagnostics;
        break;
      case 'worker':
        worker = result.data as WorkerDiagnostics;
        break;
      case 'storage':
        storage = result.data as StorageDiagnostics;
        break;
    }
  }

  const overallStatus = computeOverallStatus(statuses);
  const { summary, issues } = generateSummaryAndIssues(database, queue, worker, storage);

  deps.logger?.debug('Diagnostics complete', {
    categoriesChecked,
    issueCount: issues.length,
    overallStatus,
  });

  // Build result with only defined properties (exactOptionalPropertyTypes compliance)
  const result: SystemDiagnosticsToolResult = {
    categoriesChecked,
    issues,
    overallStatus,
    summary,
    timestamp: new Date().toISOString(),
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
  description: string;
  execute: (context: ToolContext<SystemDiagnosticsInput>) => Promise<SystemDiagnosticsToolResult>;
  id: string;
  inputSchema: typeof SystemDiagnosticsInputSchema;
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
    description:
      'Run system diagnostics to check database, queue, worker, and storage health. ' +
      'Identifies issues and provides metrics for troubleshooting.',
    execute: async (context: ToolContext<SystemDiagnosticsInput>) => {
      try {
        return await runSystemDiagnostics(context.context, deps);
      } catch (error) {
        handleToolError(
          error,
          SAFE_DIAGNOSTICS_ERRORS,
          DIAGNOSTICS_ERROR_MESSAGES.checkFailed,
          deps.logger
        );
      }
    },
    id: SYSTEM_DIAGNOSTICS_TOOL_ID,
    inputSchema: SystemDiagnosticsInputSchema,
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
