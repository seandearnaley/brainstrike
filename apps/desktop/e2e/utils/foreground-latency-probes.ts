import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Probes for the loaded foreground-latency benchmark (BST-1925).
 *
 * Renderer: rAF timestamps and PerformanceObserver `longtask` entries in the
 * visible window, sliced afterwards by phase marks taken on the renderer clock.
 * Main: `perf_hooks.monitorEventLoopDelay` per phase, plus two paced probe
 * loops that call the E2E-only seam installed by
 * `src/e2e-foreground-latency-probes.ts`.
 */

export interface LatencySummary {
  readonly max: number;
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
}

export interface MainPhaseSamples {
  readonly chatPathOpMs: readonly number[];
  readonly errors: readonly string[];
  /** monitorEventLoopDelay with the resolution subtracted, so 0 means "on time". */
  readonly eventLoopLagMs: {
    readonly max: number;
    readonly n: number;
    readonly p50: number;
    readonly p95: number;
  };
  readonly toolFileReadMs: readonly number[];
  readonly toolIndexQueryMs: readonly number[];
  readonly toolReadMs: readonly number[];
}

export interface RendererWindowSamples {
  readonly frameGapsMs: readonly number[];
  readonly longTaskDurationsMs: readonly number[];
}

export interface MainProbeConfig {
  readonly chatRunId: string;
  readonly embeddingSetId: string;
  /** A root-relative path that is never indexed: the grep's work is the same in every phase. */
  readonly grepFilePath: string;
  readonly grepPattern: string;
  readonly periodMs: number;
  readonly readTargetPath: string;
  readonly rootPath: string;
}

const ELD_RESOLUTION_MS = 10;

/** Nearest-rank percentiles: the value at rank ceil(p * n). */
export function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { max: Number.NaN, n: 0, p50: Number.NaN, p95: Number.NaN };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))] ??
    Number.NaN;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    max: round(sorted.at(-1) ?? Number.NaN),
    n: sorted.length,
    p50: round(rank(0.5)),
    p95: round(rank(0.95)),
  };
}

// ---------------------------------------------------------------- renderer --

interface RendererProbeState {
  frames: number[];
  longTasks: Array<{ duration: number; startTime: number }>;
  marks: Record<string, number>;
}

export async function installRendererFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
    };
    if (target.__brainstrikeForegroundLatencyRenderer__) {
      throw new Error('Renderer frame probe is already installed.');
    }
    const state: RendererProbeState = { frames: [], longTasks: [], marks: {} };
    target.__brainstrikeForegroundLatencyRenderer__ = state;
    const onFrame = (timestamp: number): void => {
      state.frames.push(timestamp);
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ duration: entry.duration, startTime: entry.startTime });
      }
    }).observe({ type: 'longtask' });
  });
}

/**
 * Proves the renderer probe can see what it reports: blocks the renderer's main
 * thread for `busyMs` and waits for the `longtask` entry and the frame gap it
 * must cause. A dead observer would otherwise report "zero long tasks".
 */
export async function calibrateRendererFrameProbe(
  page: Page,
  busyMs: number
): Promise<{ readonly frameGapMs: number; readonly longTaskMs: number }> {
  return await page.evaluate(async (blockMs) => {
    const state = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
      }
    ).__brainstrikeForegroundLatencyRenderer__;
    if (!state) {
      throw new Error('Renderer frame probe is not installed.');
    }
    const startedAt = performance.now();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        const blockStart = performance.now();
        while (performance.now() - blockStart < blockMs) {
          // Deliberately blocking the main thread.
        }
        resolve();
      }, 0);
    });
    const deadline = performance.now() + 5000;
    for (;;) {
      const longTask = state.longTasks.find((task) => task.startTime >= startedAt);
      const framesAfter = state.frames.filter((frame) => frame >= startedAt);
      if (longTask && framesAfter.length >= 2) {
        const previous = state.frames.filter((frame) => frame < startedAt).at(-1);
        const stamps = previous === undefined ? framesAfter : [previous, ...framesAfter];
        let frameGapMs = 0;
        for (let index = 1; index < stamps.length; index += 1) {
          frameGapMs = Math.max(
            frameGapMs,
            (stamps[index] as number) - (stamps[index - 1] as number)
          );
        }
        return { frameGapMs, longTaskMs: longTask.duration };
      }
      if (performance.now() > deadline) {
        throw new Error(
          `The renderer probe saw no long task within 5 s of a ${blockMs} ms block (long tasks: ${state.longTasks.length}, frames since: ${framesAfter.length}).`
        );
      }
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    }
  }, busyMs);
}

export async function markRendererPhase(page: Page, mark: string): Promise<void> {
  await page.evaluate((name) => {
    const state = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
      }
    ).__brainstrikeForegroundLatencyRenderer__;
    if (!state) {
      throw new Error('Renderer frame probe is not installed.');
    }
    state.marks[name] = performance.now();
  }, mark);
}

/** Frame gaps that START inside [from, to), and long tasks that start inside it. */
export async function readRendererWindow(
  page: Page,
  from: string,
  to: string
): Promise<RendererWindowSamples> {
  return await page.evaluate(
    ({ fromMark, toMark }) => {
      const state = (
        globalThis as typeof globalThis & {
          __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
        }
      ).__brainstrikeForegroundLatencyRenderer__;
      if (!state) {
        throw new Error('Renderer frame probe is not installed.');
      }
      const start = state.marks[fromMark];
      const end = state.marks[toMark];
      if (start === undefined || end === undefined) {
        throw new Error(`Renderer phase marks ${fromMark}/${toMark} are missing.`);
      }
      const frameGapsMs: number[] = [];
      for (let index = 0; index + 1 < state.frames.length; index += 1) {
        const frame = state.frames[index] as number;
        if (frame >= start && frame < end) {
          frameGapsMs.push((state.frames[index + 1] as number) - frame);
        }
      }
      const longTaskDurationsMs = state.longTasks
        .filter((task) => task.startTime >= start && task.startTime < end)
        .map((task) => task.duration);
      return { frameGapsMs, longTaskDurationsMs };
    },
    { fromMark: from, toMark: to }
  );
}

// -------------------------------------------------------------------- main --

interface ProbeLoopRecord {
  chatPathOpMs: number[];
  errors: string[];
  toolFileReadMs: number[];
  toolIndexQueryMs: number[];
  toolReadMs: number[];
}

interface MainBenchController {
  runIdle: (input: { samples: number; warmup: number }) => Promise<MainPhaseSamples>;
  startLoaded: () => void;
  stopLoaded: () => Promise<MainPhaseSamples>;
}

/**
 * Installs the main-process probe controller. Each probe loop is paced: an
 * operation starts at its next tick, or right after the previous one finishes
 * when it overran the tick. The two loops are offset by half a period.
 */
export async function installMainProbes(
  app: ElectronApplication,
  config: MainProbeConfig
): Promise<void> {
  await app.evaluate(
    (_electron, { eldResolutionMs, probeConfig }) => {
      interface Seam {
        grepToolIndex: (input: {
          embeddingSetId: string;
          filePath: string;
          pattern: string;
        }) => Promise<number>;
        readToolFile: (input: { requestedPath: string; rootPath: string }) => Promise<number>;
        writeRunStepEvent: (input: {
          eventId: string;
          runId: string;
          sequence: number;
        }) => Promise<void>;
      }
      const target = globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      };
      // Installed by src/e2e-foreground-latency-probes.ts in E2E test mode.
      const seam = (globalThis as Record<string, unknown>)[
        '__brainstrike_e2e_foreground_latency_probes__'
      ] as Seam | undefined;
      if (!seam) {
        throw new Error(
          'The main process exposes no foreground latency probes; is it running in E2E test mode?'
        );
      }
      if (target.__brainstrikeForegroundLatencyBench__) {
        throw new Error('Main foreground latency bench is already installed.');
      }
      const perfHooks = process.getBuiltinModule(
        'node:perf_hooks'
      ) as typeof import('node:perf_hooks');
      let sequence = 0;

      const chatOp = async (): Promise<number> => {
        sequence += 1;
        const startedAt = performance.now();
        await seam.writeRunStepEvent({
          eventId: `${probeConfig.chatRunId}-step-${sequence}`,
          runId: probeConfig.chatRunId,
          sequence,
        });
        return performance.now() - startedAt;
      };
      const toolOp = async (): Promise<{ file: number; index: number; total: number }> => {
        const startedAt = performance.now();
        await seam.readToolFile({
          requestedPath: probeConfig.readTargetPath,
          rootPath: probeConfig.rootPath,
        });
        const readAt = performance.now();
        await seam.grepToolIndex({
          embeddingSetId: probeConfig.embeddingSetId,
          filePath: probeConfig.grepFilePath,
          pattern: probeConfig.grepPattern,
        });
        const doneAt = performance.now();
        return { file: readAt - startedAt, index: doneAt - readAt, total: doneAt - startedAt };
      };

      const pace = async (
        offsetMs: number,
        keepGoing: () => boolean,
        operation: () => Promise<void>
      ): Promise<void> => {
        let nextAt = performance.now() + offsetMs;
        while (keepGoing()) {
          const waitMs = nextAt - performance.now();
          if (waitMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, waitMs);
            });
          }
          if (!keepGoing()) {
            return;
          }
          await operation();
          nextAt = Math.max(nextAt + probeConfig.periodMs, performance.now());
        }
      };

      const runPhase = (
        keepGoing: (record: ProbeLoopRecord) => boolean
      ): { done: Promise<void>; record: ProbeLoopRecord } => {
        const record: ProbeLoopRecord = {
          chatPathOpMs: [],
          errors: [],
          toolFileReadMs: [],
          toolIndexQueryMs: [],
          toolReadMs: [],
        };
        const guard = async (operation: () => Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error) {
            record.errors.push(error instanceof Error ? error.message : String(error));
          }
        };
        const chatLoop = pace(
          0,
          () => record.errors.length === 0 && keepGoing(record),
          () =>
            guard(async () => {
              record.chatPathOpMs.push(await chatOp());
            })
        );
        const toolLoop = pace(
          probeConfig.periodMs / 2,
          () => record.errors.length === 0 && keepGoing(record),
          () =>
            guard(async () => {
              const sample = await toolOp();
              record.toolFileReadMs.push(sample.file);
              record.toolIndexQueryMs.push(sample.index);
              record.toolReadMs.push(sample.total);
            })
        );
        return { done: Promise.all([chatLoop, toolLoop]).then(() => undefined), record };
      };

      const startLag = (): import('node:perf_hooks').IntervalHistogram => {
        const histogram = perfHooks.monitorEventLoopDelay({ resolution: eldResolutionMs });
        histogram.enable();
        return histogram;
      };
      const finishPhase = (
        record: ProbeLoopRecord,
        histogram: import('node:perf_hooks').IntervalHistogram
      ): MainPhaseSamples => {
        histogram.disable();
        const lag = (nanoseconds: number): number =>
          Math.round((nanoseconds / 1e6 - eldResolutionMs) * 1000) / 1000;
        return {
          ...record,
          eventLoopLagMs: {
            max: lag(histogram.max),
            n: histogram.count,
            p50: lag(histogram.percentile(50)),
            p95: lag(histogram.percentile(95)),
          },
        };
      };

      let loaded: {
        control: { stopped: boolean };
        histogram: import('node:perf_hooks').IntervalHistogram;
        phase: { done: Promise<void>; record: ProbeLoopRecord };
      } | null = null;

      target.__brainstrikeForegroundLatencyBench__ = {
        runIdle: async ({ samples, warmup }) => {
          const warm = runPhase(
            (record) => record.chatPathOpMs.length < warmup || record.toolReadMs.length < warmup
          );
          await warm.done;
          if (warm.record.errors.length > 0) {
            return finishPhase(warm.record, startLag());
          }
          const histogram = startLag();
          const idle = runPhase(
            (record) => record.chatPathOpMs.length < samples || record.toolReadMs.length < samples
          );
          await idle.done;
          return finishPhase(idle.record, histogram);
        },
        startLoaded: () => {
          if (loaded) {
            throw new Error('The loaded phase already started.');
          }
          const control = { stopped: false };
          const histogram = startLag();
          loaded = { control, histogram, phase: runPhase(() => !control.stopped) };
        },
        stopLoaded: async () => {
          if (!loaded) {
            throw new Error('The loaded phase never started.');
          }
          loaded.control.stopped = true;
          await loaded.phase.done;
          return finishPhase(loaded.phase.record, loaded.histogram);
        },
      };
    },
    { eldResolutionMs: ELD_RESOLUTION_MS, probeConfig: config }
  );
}

export async function runMainIdlePhase(
  app: ElectronApplication,
  input: { samples: number; warmup: number }
): Promise<MainPhaseSamples> {
  return await app.evaluate(async (_electron, phaseInput) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    return await bench.runIdle(phaseInput);
  }, input);
}

export async function startMainLoadedPhase(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    bench.startLoaded();
  });
}

export async function stopMainLoadedPhase(app: ElectronApplication): Promise<MainPhaseSamples> {
  return await app.evaluate(async () => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    return await bench.stopLoaded();
  });
}

// ------------------------------------------------------- build completion --

export interface BackfillCompletion {
  readonly current: number;
  readonly requestId: string;
  readonly total: number;
}

interface BuildSignalState {
  completions: BackfillCompletion[];
  /** Renderer `performance.now()` at each completion, on the frame probe's clock. */
  completionTimes: number[];
  errors: string[];
  waiters: Array<() => void>;
}

/**
 * Listens for the Workspace Index backfill's `complete` progress event and
 * for an embedding host that reports `error`. Install before the build starts.
 */
export async function installBuildSignals(page: Page, embeddingSetId: string): Promise<void> {
  await page.evaluate((setId) => {
    interface EmbeddingHostBridge {
      onBackfillProgress: (
        callback: (progress: {
          current: number;
          embeddingSetId: string;
          requestId: string;
          stage: string;
          total: number;
        }) => void
      ) => () => void;
      onStatus: (
        callback: (status: { lastError: string | null; state: string }) => void
      ) => () => void;
    }
    const target = globalThis as typeof globalThis & {
      __brainstrikeForegroundLatencyBuild__?: BuildSignalState;
      embeddingHost?: EmbeddingHostBridge;
    };
    const host = target.embeddingHost;
    if (!host) {
      throw new Error('window.embeddingHost is unavailable.');
    }
    const state: BuildSignalState = {
      completions: [],
      completionTimes: [],
      errors: [],
      waiters: [],
    };
    target.__brainstrikeForegroundLatencyBuild__ = state;
    const wake = (): void => {
      for (const waiter of state.waiters.splice(0)) {
        waiter();
      }
    };
    host.onBackfillProgress((progress) => {
      if (
        progress.stage === 'complete' &&
        progress.embeddingSetId === setId &&
        progress.requestId.startsWith('background-indexing-backfill:')
      ) {
        state.completionTimes.push(performance.now());
        state.completions.push({
          current: progress.current,
          requestId: progress.requestId,
          total: progress.total,
        });
        wake();
      }
    });
    host.onStatus((status) => {
      if (status.state === 'error') {
        state.errors.push(status.lastError ?? 'embedding host reported state=error');
        wake();
      }
    });
  }, embeddingSetId);
}

/** Resolves with the completion at `index`, waiting for it if it has not arrived yet. */
export async function waitForBackfillCompletion(
  page: Page,
  index: number
): Promise<BackfillCompletion> {
  return await page.evaluate(async (completionIndex) => {
    const state = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBuild__?: BuildSignalState;
      }
    ).__brainstrikeForegroundLatencyBuild__;
    if (!state) {
      throw new Error('Build signals are not installed.');
    }
    for (;;) {
      if (state.errors.length > 0) {
        throw new Error(`Embedding host failed during the build: ${state.errors.join('; ')}`);
      }
      const completion = state.completions[completionIndex];
      if (completion) {
        return completion;
      }
      await new Promise<void>((resolve) => {
        state.waiters.push(resolve);
      });
    }
  }, index);
}

/** Sets a renderer phase mark at the moment completion `index` arrived. */
export async function markRendererPhaseAtCompletion(
  page: Page,
  mark: string,
  index: number
): Promise<void> {
  await page.evaluate(
    ({ completionIndex, name }) => {
      const target = globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBuild__?: BuildSignalState;
        __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
      };
      const at = target.__brainstrikeForegroundLatencyBuild__?.completionTimes[completionIndex];
      const renderer = target.__brainstrikeForegroundLatencyRenderer__;
      if (at === undefined || !renderer) {
        throw new Error('The build completion time or the renderer frame probe is missing.');
      }
      renderer.marks[name] = at;
    },
    { completionIndex: index, name: mark }
  );
}
