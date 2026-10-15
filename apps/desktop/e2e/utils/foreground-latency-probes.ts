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
  readonly frameIntervalsMs: ReadonlyArray<{ readonly startMs: number; readonly endMs: number }>;
  readonly longTaskDurationsMs: readonly number[];
  readonly longTasks: ReadonlyArray<{ readonly startMs: number; readonly durationMs: number }>;
  readonly timeOriginMs: number;
  readonly windows: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly startMs: number;
    readonly endMs: number;
  }>;
}

export interface MainProbeConfig {
  /** The host thread whose title the chat-path probe commits. */
  readonly chatThreadId: string;
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

/**
 * Frame gaps that START inside any `[from, to)` mark pair, and long tasks that
 * start inside one. Several pairs make one window with gaps in it.
 */
export async function readRendererWindows(
  page: Page,
  windows: ReadonlyArray<readonly [from: string, to: string]>
): Promise<RendererWindowSamples> {
  return await page.evaluate((markPairs) => {
    const state = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyRenderer__?: RendererProbeState;
      }
    ).__brainstrikeForegroundLatencyRenderer__;
    if (!state) {
      throw new Error('Renderer frame probe is not installed.');
    }
    const ranges = markPairs.map(([fromMark, toMark]) => {
      const start = state.marks[fromMark];
      const end = state.marks[toMark];
      if (start === undefined || end === undefined) {
        throw new Error(`Renderer phase marks ${fromMark}/${toMark} are missing.`);
      }
      return { end, from: fromMark, start, to: toMark };
    });
    const inside = (time: number): boolean =>
      ranges.some((range) => time >= range.start && time < range.end);
    const frameGapsMs: number[] = [];
    const frameIntervalsMs: Array<{ startMs: number; endMs: number }> = [];
    for (let index = 0; index + 1 < state.frames.length; index += 1) {
      const frame = state.frames[index] as number;
      if (inside(frame)) {
        const end = state.frames[index + 1] as number;
        frameGapsMs.push(end - frame);
        frameIntervalsMs.push({ endMs: end, startMs: frame });
      }
    }
    const longTasks = state.longTasks
      .filter((task) => inside(task.startTime))
      .map((task) => ({ durationMs: task.duration, startMs: task.startTime }));
    return {
      frameGapsMs,
      frameIntervalsMs,
      longTaskDurationsMs: longTasks.map((task) => task.durationMs),
      longTasks,
      timeOriginMs: performance.timeOrigin,
      windows: ranges.map(({ end, from, start, to }) => ({ endMs: end, from, startMs: start, to })),
    };
  }, windows);
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
  pauseLoaded: () => Promise<void>;
  resumeLoaded: () => void;
  runIdle: (samples: number) => Promise<MainPhaseSamples>;
  startLoaded: () => void;
  stopLoaded: () => Promise<MainPhaseSamples>;
  warmUp: (samples: number) => Promise<readonly string[]>;
}

/**
 * Installs the main-process probe controller. Each probe loop is paced: an
 * operation starts at its next tick, or right after the previous one finishes
 * when it overran the tick. The two loops are offset by half a period. The
 * loaded phase can pause (loops stop, the lag histogram stops sampling) and
 * resume into the same samples, so its window can match the renderer's.
 */
export async function installMainProbes(
  app: ElectronApplication,
  config: MainProbeConfig
): Promise<void> {
  await app.evaluate(
    (_electron, { eldResolutionMs, probeConfig }) => {
      interface Seam {
        commitThreadUpdate: (input: { threadId: string; title: string }) => Promise<void>;
        grepToolIndex: (input: { filePath: string; pattern: string }) => Promise<number>;
        readToolFile: (input: { requestedPath: string; rootPath: string }) => Promise<number>;
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
        await seam.commitThreadUpdate({
          threadId: probeConfig.chatThreadId,
          title: `Foreground latency probe ${sequence}`,
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

      const newRecord = (): ProbeLoopRecord => ({
        chatPathOpMs: [],
        errors: [],
        toolFileReadMs: [],
        toolIndexQueryMs: [],
        toolReadMs: [],
      });
      const runLoops = (
        record: ProbeLoopRecord,
        keepGoing: (record: ProbeLoopRecord) => boolean
      ): Promise<void> => {
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
        return Promise.all([chatLoop, toolLoop]).then(() => undefined);
      };
      const enoughSamples =
        (samples: number) =>
        (record: ProbeLoopRecord): boolean =>
          record.chatPathOpMs.length < samples || record.toolReadMs.length < samples;

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
        done: Promise<void>;
        histogram: import('node:perf_hooks').IntervalHistogram;
        record: ProbeLoopRecord;
      } | null = null;
      const requireLoaded = (): NonNullable<typeof loaded> => {
        if (!loaded) {
          throw new Error('The loaded phase never started.');
        }
        return loaded;
      };
      const runLoaded = (state: NonNullable<typeof loaded>): void => {
        const control = { stopped: false };
        state.control = control;
        state.done = runLoops(state.record, () => !control.stopped);
      };
      const pauseLoaded = async (): Promise<void> => {
        const state = requireLoaded();
        if (state.control.stopped) {
          throw new Error('The loaded phase is already paused.');
        }
        state.control.stopped = true;
        await state.done;
        state.histogram.disable();
      };

      target.__brainstrikeForegroundLatencyBench__ = {
        pauseLoaded,
        resumeLoaded: () => {
          const state = requireLoaded();
          if (!state.control.stopped) {
            throw new Error('The loaded phase is not paused.');
          }
          state.histogram.enable();
          runLoaded(state);
        },
        runIdle: async (samples) => {
          const histogram = startLag();
          const record = newRecord();
          await runLoops(record, enoughSamples(samples));
          return finishPhase(record, histogram);
        },
        startLoaded: () => {
          if (loaded) {
            throw new Error('The loaded phase already started.');
          }
          const state = {
            control: { stopped: true },
            done: Promise.resolve(),
            histogram: startLag(),
            record: newRecord(),
          };
          loaded = state;
          runLoaded(state);
        },
        stopLoaded: async () => {
          const state = requireLoaded();
          if (!state.control.stopped) {
            await pauseLoaded();
          }
          return finishPhase(state.record, state.histogram);
        },
        warmUp: async (samples) => {
          const record = newRecord();
          await runLoops(record, enoughSamples(samples));
          return record.errors;
        },
      };
    },
    { eldResolutionMs: ELD_RESOLUTION_MS, probeConfig: config }
  );
}

/** Warm-up operations outside every measured window; resolves with their errors. */
export async function warmUpMainProbes(
  app: ElectronApplication,
  samples: number
): Promise<readonly string[]> {
  return await app.evaluate(async (_electron, argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    return await bench.warmUp(argument);
  }, samples);
}

/** Exactly `samples` operations per probe, with the event-loop histogram on. */
export async function runMainIdlePhase(
  app: ElectronApplication,
  samples: number
): Promise<MainPhaseSamples> {
  return await app.evaluate(async (_electron, argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    return await bench.runIdle(argument);
  }, samples);
}

export async function startMainLoadedPhase(app: ElectronApplication): Promise<void> {
  return await app.evaluate(async (_electron, _argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    bench.startLoaded();
  }, null);
}

/** Stops the loaded probes (after any in-flight operation) and the histogram. */
export async function pauseMainLoadedPhase(app: ElectronApplication): Promise<void> {
  return await app.evaluate(async (_electron, _argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    await bench.pauseLoaded();
  }, null);
}

export async function resumeMainLoadedPhase(app: ElectronApplication): Promise<void> {
  return await app.evaluate(async (_electron, _argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    bench.resumeLoaded();
  }, null);
}

export async function stopMainLoadedPhase(app: ElectronApplication): Promise<MainPhaseSamples> {
  return await app.evaluate(async (_electron, _argument) => {
    const bench = (
      globalThis as typeof globalThis & {
        __brainstrikeForegroundLatencyBench__?: MainBenchController;
      }
    ).__brainstrikeForegroundLatencyBench__;
    if (!bench) {
      throw new Error('Main foreground latency bench is not installed.');
    }
    return await bench.stopLoaded();
  }, null);
}
