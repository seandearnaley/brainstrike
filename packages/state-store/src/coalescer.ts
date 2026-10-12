// The shared write path in front of the run log (M0-A1 src/log.ts Coalescer).
//
// Process-crash contract: a chunk reaches the UI only from the append's `onCommitted`, i.e. after the batch holding it
// committed (ADR-0011: the host commits before it displays). Chunks are coalesced into one `ui.chunk` row per (run,
// flush window), adjacent deltas merged; boundary events go through `appendNow`, which flushes the thread's pending
// chunks FIRST in the same batch, so log order equals publish order.
//
// OS-crash contract: every `finish-step` chunk marks a step boundary. Once the batch holding it committed and was
// delivered, one `syncBoundary(thread)` is started per boundary. It is never awaited by `flush()` or by delivery, and a
// failed sync is recorded and re-thrown, never swallowed.
//
// Chunks are AI SDK `UIMessageChunk`s; only the fields the merge reads are typed here, so the store does not depend on
// the AI SDK.
import type { AppendItem, LogRow, RunEvent } from './run-log-types.js';

/** A UI stream chunk: `type` plus the chunk's fields. */
export type RunChunk = Readonly<Record<string, unknown>> & { readonly type: string };

/** What the Coalescer needs from a run log. */
export interface CoalescerLog {
  append(items: readonly AppendItem[], onCommitted?: () => void): Promise<readonly LogRow[]>;
  syncBoundary(threadId: string): Promise<void>;
}

export type Deliver = (threadId: string, runId: string, c: RunChunk) => void;

/** Measurement hooks. Every one is optional; nothing is retained when none is set. */
export interface CoalescerProbe {
  /** A boundary sync was issued for `threadId`, after its batch committed and was delivered. */
  readonly onBoundarySyncIssued?: (threadId: string) => void;
  /** That boundary sync completed after `ms`. */
  readonly onBoundarySyncSettled?: (threadId: string, ms: number) => void;
  /** Publish to hand-off latency of one displayed chunk (ms). */
  readonly onDisplay?: (latencyMs: number) => void;
  /** One flush: its append duration, and enqueue-to-commit latency of every raw chunk it carried (ms). */
  readonly onFlush?: (flushMs: number, enqueueToCommitMs: readonly number[]) => void;
}

interface Pending {
  readonly chunks: RunChunk[];
  readonly enqueuedAt: number[];
  rawCount: number;
  readonly runId: string;
  readonly threadId: string;
}

interface Shown {
  readonly at: number;
  readonly c: RunChunk;
  readonly runId: string;
  readonly threadId: string;
}

interface ShownItem {
  readonly c: RunChunk;
  readonly runId: string;
  readonly threadId: string;
}

const isTextLikeDelta = (c: RunChunk): boolean =>
  c.type === 'text-delta' || c.type === 'reasoning-delta';

/** Merge adjacent deltas of the same part (text, reasoning, tool input): lossless for the fold. */
export function mergeChunk(batch: RunChunk[], c: RunChunk): void {
  const last = batch.at(-1);
  if (last && last.type === c.type) {
    if (
      isTextLikeDelta(c) &&
      last['id'] === c['id'] &&
      !c['providerMetadata'] &&
      !last['providerMetadata']
    ) {
      batch[batch.length - 1] = { ...last, delta: `${String(last['delta'])}${String(c['delta'])}` };
      return;
    }
    if (c.type === 'tool-input-delta' && last['toolCallId'] === c['toolCallId']) {
      batch[batch.length - 1] = {
        ...last,
        inputTextDelta: `${String(last['inputTextDelta'])}${String(c['inputTextDelta'])}`,
      };
      return;
    }
  }
  batch.push({ ...c });
}

export class Coalescer {
  private pending: Pending[] = [];
  private shown: Shown[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Threads whose step ended (a `finish-step` chunk) in the pending batch; synced after that batch commits. */
  private boundaries: string[] = [];
  private readonly syncsInFlight = new Set<Promise<void>>();
  /** Failed boundary syncs, recorded and re-thrown (an unhandled rejection surfaces them). */
  readonly syncFailures: unknown[] = [];
  private readonly log: CoalescerLog;
  private readonly flushMs: number;
  private readonly deliver: Deliver;
  private readonly probe: CoalescerProbe;

  constructor(
    log: CoalescerLog,
    flushMs = 20,
    deliver: Deliver = () => undefined,
    probe: CoalescerProbe = {}
  ) {
    this.log = log;
    this.flushMs = flushMs;
    this.deliver = deliver;
    this.probe = probe;
  }

  push(threadId: string, runId: string, chunk: RunChunk): void {
    let p = this.pending.findLast((x) => x.threadId === threadId);
    if (!p || p.runId !== runId) {
      p = { chunks: [], enqueuedAt: [], rawCount: 0, runId, threadId };
      this.pending.push(p);
    }
    mergeChunk(p.chunks, chunk);
    p.rawCount++;
    p.enqueuedAt.push(performance.now());
    if (chunk.type === 'finish-step') {
      this.boundaries.push(threadId);
    }
    this.arm();
  }

  /**
   * One kernel sync per step boundary, started only after the boundary's batch committed and its chunks were
   * delivered. Never awaited by flush or delivery. A failed sync is never swallowed: it is recorded and re-thrown.
   */
  private syncAfterCommit(threads: readonly string[]): void {
    for (const threadId of threads) {
      const issuedAt = performance.now();
      this.probe.onBoundarySyncIssued?.(threadId);
      const p: Promise<void> = this.log.syncBoundary(threadId).then(
        () => {
          this.syncsInFlight.delete(p);
          this.probe.onBoundarySyncSettled?.(threadId, performance.now() - issuedAt);
        },
        (e: unknown) => {
          this.syncsInFlight.delete(p);
          this.syncFailures.push(e);
          throw e;
        }
      );
      this.syncsInFlight.add(p);
    }
  }

  /** Wait for every boundary sync issued so far (shutdown and harnesses only; never on the display path). */
  async drainSyncs(): Promise<void> {
    while (this.syncsInFlight.size) {
      await Promise.all([...this.syncsInFlight]);
    }
  }

  /**
   * Hand a chunk to the UI: queued behind everything already pushed, delivered when the next batch commits (a chunk
   * pushed earlier is in that batch or an earlier, already-committed one).
   */
  show(threadId: string, runId: string, c: RunChunk): void {
    this.shown.push({ at: performance.now(), c, runId, threadId });
    this.arm();
  }

  private arm(): void {
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.flushMs);
    }
  }

  /** Flush everything pending (+ optional boundary events appended after them, + chunks to show for them). */
  async flush(
    extra: readonly AppendItem[] = [],
    extraShown: readonly ShownItem[] = []
  ): Promise<readonly LogRow[]> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    const boundaries = this.boundaries;
    this.boundaries = [];
    for (const x of extraShown) {
      this.show(x.threadId, x.runId, x.c);
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const shown = this.shown;
    this.shown = [];
    const items: AppendItem[] = [
      ...batch.map(
        (p): AppendItem => ({
          event: { chunks: p.chunks, runId: p.runId, type: 'ui.chunk' } satisfies RunEvent,
          rawCount: p.rawCount,
          threadId: p.threadId,
        })
      ),
      ...extra,
    ];
    const t0 = performance.now();
    const rows = await this.log.append(
      items,
      shown.length
        ? () => {
            for (const x of shown) {
              this.deliver(x.threadId, x.runId, x.c);
              this.probe.onDisplay?.(performance.now() - x.at);
            }
          }
        : undefined
    );
    const t1 = performance.now();
    if (this.probe.onFlush) {
      this.probe.onFlush(
        t1 - t0,
        batch.flatMap((p) => p.enqueuedAt.map((at) => t1 - at))
      );
    }
    if (boundaries.length) {
      this.syncAfterCommit(boundaries);
    }
    return rows;
  }

  appendNow(
    threadId: string,
    event: RunEvent,
    rawCount?: number,
    shown?: readonly ShownItem[]
  ): Promise<readonly LogRow[]> {
    return this.flush(
      [rawCount === undefined ? { event, threadId } : { event, rawCount, threadId }],
      shown
    );
  }
}
