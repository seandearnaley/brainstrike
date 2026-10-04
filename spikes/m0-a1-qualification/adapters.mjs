/** @typedef {import('../../packages/state-store/src/coalescer.ts').RunChunk} RunChunk */
/** @typedef {import('../../packages/state-store/src/run-log-types.ts').AppendItem} AppendItem */

let ProductionCoalescer;

/** Inject the real production class; pure checks and qualification use the same adapter. */
export function configureCoalescer(Coalescer) {
  if (ProductionCoalescer && ProductionCoalescer !== Coalescer) {
    throw new Error('Production Coalescer is already configured');
  }
  ProductionCoalescer = Coalescer;
}

/** StateStore reads inclusive fromSeq; the historical host reads exclusive afterSeq. */
export function stateAdapter(store) {
  const row = (
    r
  ) => /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ ({
    threadId: r.threadId,
    seq: r.seq,
    event: r.event,
    ...(r.rawCount === undefined ? {} : { rawCount: r.rawCount }),
    ...(r.ts === undefined ? {} : { ts: r.ts }),
  });
  return /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
    append: (items, onCommitted) => store.append(items, onCommitted).then((rows) => rows.map(row)),
    read: (threadId, afterSeq = 0) =>
      store.read(threadId, afterSeq + 1).then((rows) => rows.map(row)),
    threads: () => store.threads(),
    syncBoundary: (threadId) => store.syncBoundary(threadId),
    close: () => store.close(),
  };
}

/** Historical constructor/measurements around the current production Coalescer. */
export class MeasurementCoalescer {
  latencies = [];
  flushDurations = [];
  displayLatencies = [];
  boundarySyncs = [];

  constructor(log, flushMs = 20, mode = 'after-commit', deliver = () => {}) {
    if (!ProductionCoalescer) {
      throw new Error('Configure the production Coalescer first');
    }
    if (mode !== 'after-commit') {
      throw new Error('Qualification requires commit-before-display');
    }
    this.inner = new ProductionCoalescer(
      log,
      flushMs,
      deliver,
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        onDisplay: (ms) => this.displayLatencies.push(ms),
        onFlush: (ms, latencies) => {
          this.flushDurations.push(ms);
          this.latencies.push(...latencies);
        },
        onBoundarySyncIssued: (threadId) => {
          this.boundarySyncs.push(
            /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
              threadId,
              t0: Number(process.hrtime.bigint()) / 1e6,
            }
          );
        },
        onBoundarySyncSettled: (threadId) => {
          const span = this.boundarySyncs.find(
            (s) => s.threadId === threadId && s.t1 === undefined
          );
          if (!span) {
            throw new Error(`No issued boundary for ${threadId}`);
          }
          span.t1 = Number(process.hrtime.bigint()) / 1e6;
        },
      }
    );
    this.syncFailures = this.inner.syncFailures;
  }

  push(...args) {
    return this.inner.push(...args);
  }
  show(...args) {
    return this.inner.show(...args);
  }
  flush(...args) {
    return this.inner.flush(...args);
  }
  appendNow(...args) {
    return this.inner.appendNow(...args);
  }
  drainSyncs() {
    return this.inner.drainSyncs();
  }
}
