import { DiagnosticEventWriter } from '../src/diagnostics/diagnostic-event-writer.ts';
import type { DiagnosticEvent } from '../src/diagnostics/diagnostic-events.ts';

const EVENT_COUNT = 500_000;
const MAX_PENDING = 256;
const MEASURED_SAMPLES = 15;
const WARMUP_SAMPLES = 5;

const events = Array.from(
  { length: 512 },
  (_, index): DiagnosticEvent => ({
    appVersion: 'benchmark',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: 'benchmark',
    id: `event-${index}`,
    message: 'benchmark',
    occurredAt: index,
    platform: process.platform,
    resourceId: null,
    rootId: null,
    runId: null,
    scope: null,
    sessionId: 'benchmark',
    severity: 'warn',
    source: 'benchmark',
    stack: null,
    threadId: null,
  })
);

function checksum(batch: readonly DiagnosticEvent[], dropped: number): number {
  let value = dropped;
  for (const event of batch) {
    value += event.occurredAt;
  }
  return value;
}

function runLegacyShiftQueue(): { checksum: number; elapsedMs: number } {
  const pending: DiagnosticEvent[] = [];
  let dropped = 0;
  const startedAt = performance.now();
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    pending.push(events[index % events.length] as DiagnosticEvent);
    while (pending.length > MAX_PENDING) {
      pending.shift();
      dropped += 1;
    }
  }
  const elapsedMs = performance.now() - startedAt;
  return { checksum: checksum(pending, dropped), elapsedMs };
}

async function runRingWriter(): Promise<{ checksum: number; elapsedMs: number }> {
  let written: readonly DiagnosticEvent[] = [];
  const writer = new DiagnosticEventWriter({
    flushBatchSize: EVENT_COUNT + 1,
    flushIntervalMs: 60_000,
    makeDroppedEvent: (droppedCount) => ({
      ...(events[0] as DiagnosticEvent),
      id: `dropped-${droppedCount}`,
      occurredAt: droppedCount,
    }),
    maxPending: MAX_PENDING,
    sink: {
      insertBatch: async (batch) => {
        written = batch;
      },
    },
  });
  const startedAt = performance.now();
  for (let index = 0; index < EVENT_COUNT; index += 1) {
    writer.enqueue(events[index % events.length] as DiagnosticEvent);
  }
  const elapsedMs = performance.now() - startedAt;
  await writer.dispose();
  const [marker, ...pending] = written;
  const dropped = marker?.occurredAt ?? 0;
  return { checksum: checksum(pending, dropped), elapsedMs };
}

function summarize(samples: readonly number[]): { max: number; median: number; min: number } {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    max: sorted.at(-1) as number,
    median: sorted[Math.floor(sorted.length / 2)] as number,
    min: sorted[0] as number,
  };
}

for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
  runLegacyShiftQueue();
  await runRingWriter();
}

const legacySamples: number[] = [];
const ringSamples: number[] = [];
let expectedChecksum: number | null = null;
for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
  const legacy = runLegacyShiftQueue();
  const ring = await runRingWriter();
  expectedChecksum ??= legacy.checksum;
  if (legacy.checksum !== expectedChecksum || ring.checksum !== expectedChecksum) {
    throw new Error(
      `Benchmark checksum mismatch: expected ${expectedChecksum}, legacy ${legacy.checksum}, ring ${ring.checksum}`
    );
  }
  legacySamples.push(legacy.elapsedMs);
  ringSamples.push(ring.elapsedMs);
}

process.stdout.write(
  `${JSON.stringify(
    {
      environment: {
        arch: process.arch,
        node: process.version,
        platform: process.platform,
      },
      fixture: {
        checksum: expectedChecksum,
        eventCount: EVENT_COUNT,
        maxPending: MAX_PENDING,
        measuredSamples: MEASURED_SAMPLES,
        warmupSamples: WARMUP_SAMPLES,
      },
      legacyShiftMs: summarize(legacySamples),
      ringWriterMs: summarize(ringSamples),
    },
    null,
    2
  )}\n`
);
