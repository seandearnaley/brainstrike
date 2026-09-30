import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DbHostManager');

export interface AbandonedRequest {
  readonly requestKind: string;
  readonly startedAt: number;
  readonly timedOutAt: number;
  readonly timeoutMs: number;
}

// Bounded memory of requests that timed out client-side while the DB host may
// still be executing them (the host runs one statement at a time; an IPC
// timeout does NOT cancel the statement). A late response for one of these
// must be logged, never dropped silently.
const MAX_ABANDONED_REQUESTS = 64;

export class AbandonedRequestLedger {
  readonly #entries = new Map<string, AbandonedRequest>();
  readonly #stalenessCeilingMs: number;

  /** `stalenessCeilingMs` is the longest legitimate in-flight request (the maintenance timeout). */
  constructor(stalenessCeilingMs: number) {
    this.#stalenessCeilingMs = stalenessCeilingMs;
  }

  record(id: string, request: AbandonedRequest): void {
    if (this.#entries.size >= MAX_ABANDONED_REQUESTS && !this.#evictStale()) {
      // Keep the OLDEST entries: the host runs one statement at a time, so in
      // a timeout burst the oldest abandoned request is the statement that is
      // actually wedging the host — evicting it would silently drop exactly
      // the late-completion log this map exists to produce. The newer entries
      // are queued-behind victims whose late responses add little.
      logger.debug(
        { droppedRequestKind: request.requestKind, requestId: id },
        'Abandoned-request map full; not tracking further timed-out request'
      );
      return;
    }
    this.#entries.set(id, request);
  }

  /** Removes and returns the entry for a late response, so it is logged exactly once. */
  take(id: string): AbandonedRequest | undefined {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    return entry;
  }

  state(now: number): {
    readonly hasStaleAbandonedRequest: boolean;
    readonly recentAbandonedCount: number;
  } {
    let hasStaleAbandonedRequest = false;
    let recentAbandonedCount = 0;
    for (const request of this.#entries.values()) {
      if (now - request.timedOutAt < request.timeoutMs) {
        recentAbandonedCount += 1;
      } else {
        hasStaleAbandonedRequest = true;
      }
    }
    return { hasStaleAbandonedRequest, recentAbandonedCount };
  }

  clearStale(now: number): void {
    for (const [id, request] of this.#entries) {
      if (now - request.timedOutAt >= request.timeoutMs) {
        this.#entries.delete(id);
      }
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  // A request that NEVER replies (host alive, statement truly wedged
  // forever — no termination-triggering request kind ever fires to clear()
  // the map) would otherwise occupy its slot for the life of the host,
  // permanently disabling this log for every subsequent timeout once the map
  // fills. Once an entry has outlived the longest legitimate in-flight
  // request (the maintenance-timeout ceiling), it can only be dead weight —
  // evict it to make room for tracking new timeouts.
  #evictStale(): boolean {
    const oldest = this.#entries.entries().next().value as [string, AbandonedRequest] | undefined;
    if (!oldest) {
      return false;
    }
    const [oldestId, oldestRequest] = oldest;
    const age = Date.now() - oldestRequest.startedAt;
    if (age < this.#stalenessCeilingMs) {
      return false;
    }
    this.#entries.delete(oldestId);
    logger.debug(
      { ageMs: age, requestId: oldestId, requestKind: oldestRequest.requestKind },
      'Abandoned-request entry exceeded staleness ceiling without a late response; evicting'
    );
    return true;
  }
}
