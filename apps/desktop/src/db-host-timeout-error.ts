import type { DbHostRequest } from './db-host-protocol';

export class DbHostRequestTimeoutError extends Error {
  readonly hasStaleAbandonedRequest: boolean;
  readonly hostSaturated: boolean;
  readonly pendingCount: number;
  readonly recentAbandonedCount: number;
  readonly requestKind: DbHostRequest['kind'];
  readonly timeoutMs: number;
  readonly willTerminateHost: boolean;

  constructor(options: {
    readonly hasStaleAbandonedRequest?: boolean;
    readonly pendingCount: number;
    readonly recentAbandonedCount?: number;
    readonly requestKind: DbHostRequest['kind'];
    readonly timeoutMs: number;
    readonly willTerminateHost: boolean;
  }) {
    super(`DB host request timed out: ${options.requestKind}`);
    this.name = 'DbHostRequestTimeoutError';
    this.hasStaleAbandonedRequest = options.hasStaleAbandonedRequest ?? false;
    this.pendingCount = options.pendingCount;
    this.recentAbandonedCount = options.recentAbandonedCount ?? 0;
    this.requestKind = options.requestKind;
    this.timeoutMs = options.timeoutMs;
    this.willTerminateHost = options.willTerminateHost;
    this.hostSaturated =
      !(options.willTerminateHost || this.hasStaleAbandonedRequest) &&
      (options.pendingCount > 1 || this.recentAbandonedCount > 0);
  }
}
