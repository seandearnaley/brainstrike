import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * PROOF ONLY (windows-smoke-sweep3, not for merge). Main-side launch phases of
 * the agent host and the indexer, each with Main's event-loop delay since the
 * previous line, on stderr: a packaged Windows Main's stderr reaches the E2E
 * harness, its utilities' does not. Off unless BRAINSTRIKE_PROOF_LAUNCH_TIMING=1.
 */
const enabled = process.env['BRAINSTRIKE_PROOF_LAUNCH_TIMING'] === '1';
const loopDelay = enabled ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
const STALL_REPORT_MS = 250;

if (loopDelay) {
  loopDelay.enable();
  // A stall anywhere in Main, not only during a launch phase.
  const stalls = monitorEventLoopDelay({ resolution: 10 });
  stalls.enable();
  setInterval(() => {
    const maxMs = Math.round(stalls.max / 1e6);
    if (maxMs >= STALL_REPORT_MS) {
      process.stderr.write(
        `[main-loop-stall] ${JSON.stringify({ at: new Date().toISOString(), maxMs })}\n`
      );
    }
    stalls.reset();
  }, 1000).unref();
}

export function proofLaunchTiming(
  scope: 'agent-host' | 'indexer',
  phase: string,
  fields: Record<string, unknown> = {}
): void {
  if (!loopDelay) {
    return;
  }
  const line = {
    at: new Date().toISOString(),
    loopMaxMs: Math.round(loopDelay.max / 1e6),
    phase,
    scope,
    ...fields,
  };
  loopDelay.reset();
  process.stderr.write(`[launch-timing] ${JSON.stringify(line)}\n`);
}
