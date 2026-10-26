/** One host startup step: how long it took and whether it finished. */
export interface StartupPhase {
  readonly durationMs: number;
  /** A failed step's error message: a cancelled startup reads as such. */
  readonly error?: string;
  readonly outcome: 'ok' | 'failed';
  readonly phase: string;
}
export type StartupPhaseSink = (phase: StartupPhase) => void;

/** Runs `step` as `phase`, reporting its duration and outcome to `sink` when there is one. */
export async function timeStartupPhase<T>(
  sink: StartupPhaseSink | undefined,
  phase: string,
  step: () => Promise<T>
): Promise<T> {
  if (!sink) {
    return await step();
  }
  const started = performance.now();
  try {
    const value = await step();
    sink({ durationMs: performance.now() - started, outcome: 'ok', phase });
    return value;
  } catch (cause) {
    sink({
      durationMs: performance.now() - started,
      error: cause instanceof Error ? cause.message : String(cause),
      outcome: 'failed',
      phase,
    });
    throw cause;
  }
}

/**
 * The host process's startup record: one JSON line per phase on stderr, at every log level, so a
 * host that is slow to report ready says which step it spent the time in. Stdout stays JSON-RPC.
 */
export function stderrStartupPhases(): StartupPhaseSink {
  return ({ durationMs, error, outcome, phase }) => {
    process.stderr.write(
      `${JSON.stringify({
        durationMs: Math.round(durationMs),
        ...(error === undefined ? {} : { error }),
        event: 'host-startup-phase',
        outcome,
        phase,
        pid: process.pid,
        time: new Date().toISOString(),
      })}\n`
    );
  };
}
