// biome-ignore assist/source/organizeImports: Preserve reviewed module evaluation order.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { configureCoalescer, stateAdapter } from './adapters.mjs';
import {
  provenance,
  verifyFixture,
  verifyRuntime,
  verifySettings,
  verifyStateSource,
} from './prepare.mjs';
import { contentionPercentile, displayPercentile, rounded, summary } from './statistics.mjs';
import { validateRunOutcomes } from './run-outcomes.mjs';

if (process.env.BRAINSTRIKE_M0_A1_QUALIFICATION !== '1') {
  throw new Error(
    'Native qualification is held; explicit BRAINSTRIKE_M0_A1_QUALIFICATION=1 is required'
  );
}
const [mode, candidate, stateEntry, rawOut, bigFile] = process.argv.slice(2);
if (!(['display', 'contend', 'no-host'].includes(mode) && ['S', 'P'].includes(candidate))) {
  throw new Error(
    'Usage: run.mjs <display|contend|no-host> <S|P> <state-src/index.ts> <rawOut> [100MiBFile]'
  );
}
verifyFixture();
const entry = verifyStateSource(stateEntry);
const runtime = verifyRuntime(entry);
const production = await import(pathToFileURL(entry).href);
configureCoalescer(production.Coalescer);
const { reasoning, text, toolCall } = await import('./.runtime/src/mock.ts');
const { makeHost } = await import('./.runtime/test/helpers.ts');
const { RunEventLog } = await import('./.runtime/src/log.ts');
const children = mode === 'display' ? 3 : 8;
const steps = mode === 'display' ? 4 : 20;
const deltas = mode === 'display' ? 500 : 60;
const body = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '
  .repeat(Math.ceil((deltas * 6) / 57))
  .slice(0, deltas * 6);
const labels = Array.from({ length: children }, (_, i) => `C${i}`);
const dir = mkdtempSync(join(tmpdir(), `m0-a1-${candidate}-`));
const writeSpans = [];
const syncSpans = [];
let store;
let settings;
let co;
let host;
const eventLoop = monitorEventLoopDelay({ resolution: mode === 'display' ? 10 : 1 });
try {
  if (candidate === 'S') {
    const state = await production.StateStore.open(
      join(dir, 'store'),
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        onWriteSpan: (span) => writeSpans.push(span),
        onSyncSpan: (span) => syncSpans.push(span),
      }
    );
    store = stateAdapter(state);
    settings = state.settings;
    verifySettings(settings);
  } else {
    store = await RunEventLog.open(join(dir, 'store'));
  }
  const fixture = await makeHost(
    (call) => {
      const step = (last) => [
        ...reasoning(mode === 'display' ? 'thinking '.repeat(20) : 'thinking'),
        ...text(body, deltas),
        ...(last ? [] : toolCall('read_file', { path: `f${call.index}.ts` })),
      ];
      if (call.label === 'root') {
        return call.index === 0
          ? labels.flatMap((label) =>
              toolCall(
                'delegate',
                /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
                  task: `stream ${label}`,
                  label,
                  background: true,
                }
              )
            )
          : step(call.index >= steps - 1);
      }
      if (call.label === 'root-wake') {
        return text('done');
      }
      return step(call.index >= steps - 1);
    },
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      chunkDelayMs: 1,
      flushMs: 20,
      log: store,
      readMs: 5,
      publish: 'after-commit',
    }
  );
  host = fixture.host;
  co = host.co;
  let shown = 0;
  host.onChunk(() => {
    shown += 1;
  });
  const idle = [];
  if (mode !== 'display') {
    const size = (await readFile(bigFile)).length;
    if (size !== 100 * 1024 * 1024) {
      throw new Error(`Contention file must be 100MiB; observed ${size}`);
    }
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      await readFile(bigFile);
      idle.push(performance.now() - start);
    }
  }
  const before = loadavg();
  const start = performance.now();
  eventLoop.enable();
  let finished = false;
  let rootResult;
  const done = (
    mode === 'no-host'
      ? new Promise((resolve) => setTimeout(resolve, 2500))
      : host
          .sendUserMessage(mode === 'display' ? 'thread-m0' : 'thread-contend', 'go')
          .then((result) => {
            rootResult = result;
            return host.waitIdle();
          })
  )
    .then(
      () => ({ ok: true }),
      (
        error
      ) => /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ ({
        ok: false,
        error,
      })
    )
    .finally(() => {
      finished = true;
    });
  const loaded = [];
  if (mode !== 'display') {
    while (!finished) {
      const readStart = performance.now();
      await readFile(bigFile);
      loaded.push(performance.now() - readStart);
    }
  }
  const completion = await done;
  if (!completion.ok) {
    throw completion.error;
  }
  const wallMs = performance.now() - start;
  eventLoop.disable();
  await co.drainSyncs();
  if (co.syncFailures.length !== 0) {
    throw new Error('Boundary sync failed');
  }
  if (
    mode === 'display' &&
    (shown !== 7713 ||
      co.latencies.length !== 7713 ||
      co.displayLatencies.length !== 7713 ||
      co.boundarySyncs.length !== 17)
  ) {
    throw new Error(
      `Original workload signature mismatch: shown=${shown}, chunks=${co.latencies.length}, display=${co.displayLatencies.length}, boundaries=${co.boundarySyncs.length}`
    );
  }
  if (mode === 'contend' && co.boundarySyncs.length !== 181) {
    throw new Error(`Original contention boundary count mismatch: ${co.boundarySyncs.length}`);
  }
  if (candidate === 'S' && syncSpans.length !== co.boundarySyncs.length) {
    throw new Error(
      `Production boundary/span count mismatch: ${co.boundarySyncs.length}/${syncSpans.length}`
    );
  }
  const runOutcomes = mode === 'no-host' ? [] : await validateRunOutcomes(host, labels, rootResult);
  const percentile = mode === 'display' ? displayPercentile : contentionPercentile;
  const out =
    /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
      candidate,
      mode,
      runtime,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpus: availableParallelism(),
      sourceBase: provenance.base,
      settings,
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? '4 (default)',
      noHostBaseline: mode === 'no-host',
      workload:
        /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
          children,
          steps,
          deltas,
          chunkDelayMs: 1,
          flushMs: 20,
          readMs: 5,
        },
      shown,
      chunks: co.latencies.length,
      boundaries: co.boundarySyncs.length,
      runOutcomes,
      wallMs: rounded(wallMs),
      ...(co.displayLatencies.length
        ? { displayLatencyMs: summary(co.displayLatencies, percentile) }
        : {}),
      ...(idle.length
        ? {
            fileBytes: 100 * 1024 * 1024,
            idleReadMs: summary(idle, percentile),
            loadedReadMs: summary(loaded, percentile),
            ratioP95: rounded(percentile(loaded, 95) / percentile(idle, 95)),
          }
        : {}),
      eventLoopDelayMs:
        /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
          p99: rounded(eventLoop.percentile(99) / 1e6),
          max: rounded(eventLoop.max / 1e6),
        },
      loadavg:
        /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
          before,
          after: loadavg(),
        },
      instrumentation: 'Production probes and worker spans; no kernel tracer or J negative control',
    };
  writeFileSync(
    rawOut,
    JSON.stringify(
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        out,
        display: co.displayLatencies.map(rounded),
        append: co.latencies.map(rounded),
        idle: idle.map(rounded),
        loaded: loaded.map(rounded),
        writeSpans,
        syncSpans,
        boundarySyncs: co.boundarySyncs,
      },
      null,
      2
    )
  );
  // biome-ignore lint/suspicious/noConsole: CLI result/progress output preserves the measured protocol.
  console.log(`M0PORT ${JSON.stringify(out)}`);
} finally {
  eventLoop.disable();
  try {
    if (host) {
      await host.waitIdle();
    }
    if (co) {
      await co.drainSyncs();
    }
  } finally {
    if (store) {
      await store.close();
    }
    rmSync(
      dir,
      /* biome-ignore assist/source/useSortedKeys: Preserve measured property evaluation and output key order. */ {
        recursive: true,
        force: true,
      }
    );
  }
}
