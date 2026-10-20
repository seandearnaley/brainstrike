import { performance } from 'node:perf_hooks';

// PROOF ONLY: preserve phase boundaries before choosing a production fix or budget.
const enabled = process.env['BRAINSTRIKE_PROOF_LAUNCH_TIMING'] === '1';
let nextId = 0;

export async function proofStartupPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  if (!enabled) {
    return work();
  }
  const id = ++nextId;
  const start = performance.now();
  const cpu = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  const print = (stage: string, fields: Record<string, unknown> = {}): void => {
    process.stderr.write(
      `[lease-startup-proof] ${JSON.stringify({
        at: new Date().toISOString(),
        id,
        phase,
        pid: process.pid,
        stage,
        ...fields,
      })}\n`
    );
  };
  print('start');
  try {
    return await work();
  } catch (cause) {
    print('error', { error: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally {
    const used = process.cpuUsage(cpu);
    const elapsed = performance.eventLoopUtilization(loop);
    print('end', {
      cpuSystemMs: used.system / 1000,
      cpuUserMs: used.user / 1000,
      elapsedMs: performance.now() - start,
      loopActiveMs: elapsed.active,
      loopIdleMs: elapsed.idle,
    });
  }
}
