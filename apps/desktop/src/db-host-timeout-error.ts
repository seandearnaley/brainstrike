import type { DatabaseInitPhaseReport } from '@brainstrike/types';
import type { DbHostRequest } from './db-host-protocol';

const BYTES_PER_MIB = 1024 * 1024;

function formatMib(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MIB)} MiB`;
}

function formatBudget(timeoutMs: number): string {
  return timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
}

function describePhase(report: DatabaseInitPhaseReport): string | null {
  switch (report.phase) {
    case 'open-database':
      return `pg_wal ${formatMib(report.pgWalBytes)}`;
    case 'index-rebuild':
      return `${report.index.schema}.${report.index.index}, ${formatMib(report.index.heapBytes + report.index.toastBytes)} table`;
    case 'migration':
      return null;
  }
}

/**
 * The text a person sees when init dies: an `init` that timed out after a phase report names that
 * phase and the budget that expired; every other timeout keeps its original one-line message.
 */
function formatTimeoutMessage(options: {
  readonly phase: DatabaseInitPhaseReport | null;
  readonly requestKind: DbHostRequest['kind'];
  readonly timeoutMs: number;
}): string {
  const { phase, requestKind, timeoutMs } = options;
  if (requestKind !== 'init' || !phase) {
    return `DB host request timed out: ${requestKind}`;
  }
  const detail = describePhase(phase);
  const budget = `budget ${formatBudget(timeoutMs)}`;
  return `DB host init timed out in phase ${phase.phase} (${detail ? `${detail}, ` : ''}${budget})`;
}

export class DbHostRequestTimeoutError extends Error {
  readonly hasStaleAbandonedRequest: boolean;
  readonly hostSaturated: boolean;
  readonly pendingCount: number;
  /** The `init` phase whose budget expired; null before the first report and for every other request. */
  readonly phase: DatabaseInitPhaseReport | null;
  /** Progress reports that re-armed this request's deadline before it expired. */
  readonly progressCount: number;
  readonly recentAbandonedCount: number;
  readonly requestKind: DbHostRequest['kind'];
  readonly timeoutMs: number;
  readonly willTerminateHost: boolean;

  constructor(options: {
    readonly hasStaleAbandonedRequest?: boolean;
    readonly pendingCount: number;
    readonly phase?: DatabaseInitPhaseReport | null;
    readonly progressCount?: number;
    readonly recentAbandonedCount?: number;
    readonly requestKind: DbHostRequest['kind'];
    readonly timeoutMs: number;
    readonly willTerminateHost: boolean;
  }) {
    const phase = options.phase ?? null;
    super(
      formatTimeoutMessage({
        phase,
        requestKind: options.requestKind,
        timeoutMs: options.timeoutMs,
      })
    );
    this.name = 'DbHostRequestTimeoutError';
    this.hasStaleAbandonedRequest = options.hasStaleAbandonedRequest ?? false;
    this.pendingCount = options.pendingCount;
    this.phase = phase;
    this.progressCount = options.progressCount ?? 0;
    this.recentAbandonedCount = options.recentAbandonedCount ?? 0;
    this.requestKind = options.requestKind;
    this.timeoutMs = options.timeoutMs;
    this.willTerminateHost = options.willTerminateHost;
    this.hostSaturated =
      !(options.willTerminateHost || this.hasStaleAbandonedRequest) &&
      (options.pendingCount > 1 || this.recentAbandonedCount > 0);
  }
}
