// The streaming workload of the SIGKILL and kernel-sync harnesses, written the way HostCore writes a run: per thread,
// `run.started`, then per step a reasoning part, `deltas` text deltas and (all but the last step) a read_file tool call
// that takes 5 ms, closed by `finish-step` (a step boundary), then `run.finished`. One model chunk per ms. Each chunk is
// its own NORMAL `stream.chunk` append and is shown only once that append resolved (ADR-0011: the host commits before
// it displays). After a committed `finish-step` the run awaits one `syncBoundary`, as the host's run loop does. The
// harness commits every chunk, text deltas included, so it writes far more rows than the host now does (ADR-0011
// amendments: text, reasoning and tool input stream as uncommitted telemetry).
import type { StateStore } from '../../src/state-store.js';
import { sleep } from '../helpers/fs.js';

/** A UI stream chunk: `type` plus the chunk's fields. */
export type RunChunk = Readonly<Record<string, unknown>> & { readonly type: string };

/** A chunk handed to the UI. */
export type Show = (threadId: string, runId: string, c: RunChunk) => void;

export interface StreamSpec {
  readonly runId: string;
  readonly steps: number;
  /** Text of step `i` as `deltas` pieces. */
  readonly text: (step: number) => readonly string[];
  readonly threadId: string;
}

type RunLog = Pick<StateStore, 'append' | 'syncBoundary'>;

/** Commit, then show; a committed step boundary is synced. 1 ms between model chunks. */
async function emit(log: RunLog, show: Show, s: StreamSpec, c: RunChunk): Promise<void> {
  await log.append([
    { event: { chunk: c, runId: s.runId, type: 'stream.chunk' }, threadId: s.threadId },
  ]);
  show(s.threadId, s.runId, c);
  if (c.type === 'finish-step') {
    await log.syncBoundary(s.threadId);
  }
  await sleep(1);
}

export async function streamRun(log: RunLog, show: Show, s: StreamSpec): Promise<void> {
  await log.append([{ event: { runId: s.runId, type: 'run.started' }, threadId: s.threadId }]);
  await emit(log, show, s, { messageId: `${s.runId}-m`, type: 'start' });
  for (let step = 0; step < s.steps; step++) {
    const id = `${s.runId}-${step}`;
    const chunks: RunChunk[] = [
      { type: 'start-step' },
      { id: `r${id}`, type: 'reasoning-start' },
      { delta: `thinking ${s.runId} `, id: `r${id}`, type: 'reasoning-delta' },
      { delta: `step ${step}`, id: `r${id}`, type: 'reasoning-delta' },
      { id: `r${id}`, type: 'reasoning-end' },
      { id: `t${id}`, type: 'text-start' },
      ...s.text(step).map((delta) => ({ delta, id: `t${id}`, type: 'text-delta' })),
      { id: `t${id}`, type: 'text-end' },
    ];
    for (const c of chunks) {
      await emit(log, show, s, c);
    }
    if (step < s.steps - 1) {
      const toolCallId = `call_${id}`;
      const input = { path: `${s.runId}-${step}.ts` };
      await emit(log, show, s, { toolCallId, toolName: 'read_file', type: 'tool-input-start' });
      await emit(log, show, s, { input, toolCallId, toolName: 'read_file', type: 'tool-call' });
      await sleep(5); // the read_file tool
      await emit(log, show, s, {
        output: { content: `contents of ${s.runId}-${step}.ts` },
        toolCallId,
        type: 'tool-result',
      });
    }
    await emit(log, show, s, { type: 'finish-step' });
  }
  await emit(log, show, s, { type: 'finish' });
  await log.append([
    { event: { runId: s.runId, status: 'completed', type: 'run.finished' }, threadId: s.threadId },
  ]);
}

/** Unique, ordered tokens so every displayed delta is identifiable in the log. */
export const tokens = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `<${tag}:${i}>`);
