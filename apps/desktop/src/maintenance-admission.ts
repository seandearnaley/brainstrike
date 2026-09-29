import { MASTRA_BACKGROUND_TASKS_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { DatabaseWorkPriority } from '@brainstrike/db';

/**
 * Admission shared by the desktop maintenance schedulers whose statements the
 * DB host cannot preempt (`VACUUM (ANALYZE)`, HNSW `CREATE INDEX`). The host
 * dispatches serially, so once such a statement starts every other query waits
 * for it; see database.md, MAINTENANCE ADMISSION.
 */

/** BST-1333: continuous scheduler idle required before an unpreemptable statement may start. */
export const DEFAULT_MAINTENANCE_QUIET_PERIOD_MS = 15_000;

export interface MaintenanceSchedulerSnapshot {
  readonly queued: Record<DatabaseWorkPriority, number>;
  readonly runningPriority: DatabaseWorkPriority | null;
}

export function isDatabaseSchedulerBusy(snapshot: MaintenanceSchedulerSnapshot): boolean {
  return (
    snapshot.runningPriority !== null ||
    snapshot.queued.background > 0 ||
    snapshot.queued.foreground > 0 ||
    snapshot.queued.normal > 0
  );
}

export interface SustainedIdleObserver {
  /** Milliseconds since the last busy observation, or null when none was recorded. */
  readonly idleForMs: () => number | null;
  /** Record a scheduler sample; a busy one restarts the quiet window. */
  readonly observe: (snapshot: MaintenanceSchedulerSnapshot) => void;
  /** Count now as busy: a booting app is exactly what the quiet window protects. */
  readonly seedBusy: () => void;
}

export function createSustainedIdleObserver(now: () => Date): SustainedIdleObserver {
  let lastBusyAtMs: number | null = null;
  return {
    idleForMs: () => (lastBusyAtMs === null ? null : now().getTime() - lastBusyAtMs),
    observe: (snapshot) => {
      if (isDatabaseSchedulerBusy(snapshot)) {
        lastBusyAtMs = now().getTime();
      }
    },
    seedBusy: () => {
      lastBusyAtMs = now().getTime();
    },
  };
}

export interface InFlightAssistantWork {
  readonly backgroundTasks: number;
  readonly runs: number;
}

// Built where it runs: memory-schema constants are never read at module scope
// (scripts/verify-mastra-schema-init-order.mjs).
function inFlightAssistantWorkSql(): string {
  return `SELECT
  (SELECT COUNT(*)::int FROM brainstrike_assistant_thread_runs
    WHERE status IN ('running', 'cancelling')) AS runs,
  (SELECT COUNT(*)::int FROM ${MASTRA_BACKGROUND_TASKS_TABLE}
    WHERE status IN ('pending', 'running')) AS "backgroundTasks"`;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Assistant work that issues database queries at times no scheduler sample can
 * predict: a run still streaming (its model may be silent for tens of seconds)
 * or a background child task still executing. A suspended task waits on the
 * user and issues nothing until a decision resumes it as a new run.
 */
export async function readInFlightAssistantWork(db: {
  readonly query: (sql: string) => Promise<{ readonly rows: readonly unknown[] }>;
}): Promise<InFlightAssistantWork> {
  const { rows } = await db.query(inFlightAssistantWorkSql());
  const [row] = rows;
  if (rows.length !== 1 || typeof row !== 'object' || row === null) {
    throw new Error('In-flight assistant work read returned no single row.');
  }
  const runs: unknown = Reflect.get(row, 'runs');
  const backgroundTasks: unknown = Reflect.get(row, 'backgroundTasks');
  if (!(isCount(runs) && isCount(backgroundTasks))) {
    throw new Error('In-flight assistant work read returned non-count values.');
  }
  return { backgroundTasks, runs };
}
