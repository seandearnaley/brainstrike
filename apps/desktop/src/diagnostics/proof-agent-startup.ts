type Phase =
  | 'entry-evaluated'
  | 'entry-body'
  | 'parent-first-message'
  | 'parent-message-observed'
  | 'control-evaluation-start'
  | 'control-evaluation-end'
  | 'control-bound';

/** PROOF ONLY. Synchronous marks; no workers, timers, imports, payloads or extra awaits. */
export function proofAgentStartup(phase: Phase): void {
  if (process.env['BRAINSTRIKE_PROOF_STARTUP'] !== '1') {
    return;
  }
  process.stderr.write(
    `[agent-startup-proof] ${JSON.stringify({
      at: Date.now(),
      monotonicMs: performance.now(),
      phase,
      pid: process.pid,
      ppid: process.ppid,
      timeOrigin: performance.timeOrigin,
    })}\n`
  );
}
