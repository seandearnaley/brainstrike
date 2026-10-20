import { monitorEventLoopDelay } from 'node:perf_hooks';

// PROOF ONLY. One monitor per Main, including when this module is bundled twice.
export const proofLaunchTimingEnabled = process.env['BRAINSTRIKE_PROOF_LAUNCH_TIMING'] === '1';
interface ProofMonitor {
  readonly delay: ReturnType<typeof monitorEventLoopDelay>;
  windowStartedAt: string;
}
const processGlobal = globalThis as typeof globalThis & {
  __brainstrikeProofLaunchMonitor?: ProofMonitor;
};
function monitor(): ProofMonitor {
  const state = {
    delay: monitorEventLoopDelay({ resolution: 10 }),
    windowStartedAt: new Date().toISOString(),
  };
  state.delay.enable();
  setInterval(() => {
    const at = new Date().toISOString();
    const maxMs = state.delay.count === 0 ? null : state.delay.max / 1e6;
    if (maxMs !== null && maxMs >= 250) {
      process.stderr.write(
        `[main-loop-stall] ${JSON.stringify({ at, maxMs, pid: process.pid, windowStartedAt: state.windowStartedAt })}\n`
      );
    }
    state.delay.reset();
    state.windowStartedAt = at;
  }, 1000).unref();
  return state;
}
let state: ProofMonitor | undefined;
if (proofLaunchTimingEnabled) {
  processGlobal.__brainstrikeProofLaunchMonitor ??= monitor();
  state = processGlobal.__brainstrikeProofLaunchMonitor;
}

export function proofLaunchTiming(
  scope: 'agent-host' | 'indexer',
  phase: string,
  fields: Record<string, unknown> = {}
): void {
  if (!state) {
    return;
  }
  process.stderr.write(
    `[launch-timing] ${JSON.stringify({
      at: new Date().toISOString(),
      loopMaxMs: state.delay.count === 0 ? null : state.delay.max / 1e6,
      loopWindowStartedAt: state.windowStartedAt,
      mainPid: process.pid,
      phase,
      scope,
      ...fields,
    })}\n`
  );
}
