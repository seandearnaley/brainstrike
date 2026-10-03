// The streaming workload of the M0-A1 harnesses (scripts/m0/kill-host.ts, scripts/m0/run.ts), driven straight through
// the Coalescer. The spike drove it through its AI SDK run host and a scripted mock model; the run host belongs to M3,
// so this reproduces the chunk stream the host handed the Coalescer: per thread, `run.started`, then per step a
// reasoning part, `deltas` text deltas and (all but the last step) a read_file tool call that takes 5 ms, closed by
// `finish-step` (a step boundary), then `run.finished`. One model chunk per ms, as the spike's mock.
import type { Coalescer, RunChunk } from '../../src/coalescer.js';
import { sleep } from '../helpers/fs.js';

export interface StreamSpec {
  readonly runId: string;
  readonly steps: number;
  /** Text of step `i` as `deltas` pieces. */
  readonly text: (step: number) => readonly string[];
  readonly threadId: string;
}

/** Push then show every chunk, as the run host does; 1 ms between model chunks. */
async function emit(co: Coalescer, s: StreamSpec, c: RunChunk): Promise<void> {
  co.push(s.threadId, s.runId, c);
  co.show(s.threadId, s.runId, c);
  await sleep(1);
}

export async function streamRun(co: Coalescer, s: StreamSpec): Promise<void> {
  await co.appendNow(s.threadId, { runId: s.runId, type: 'run.started' });
  await emit(co, s, { messageId: `${s.runId}-m`, type: 'start' });
  for (let step = 0; step < s.steps; step++) {
    const id = `${s.runId}-${step}`;
    await emit(co, s, { type: 'start-step' });
    await emit(co, s, { id: `r${id}`, type: 'reasoning-start' });
    await emit(co, s, { delta: `thinking ${s.runId} `, id: `r${id}`, type: 'reasoning-delta' });
    await emit(co, s, { delta: `step ${step}`, id: `r${id}`, type: 'reasoning-delta' });
    await emit(co, s, { id: `r${id}`, type: 'reasoning-end' });
    await emit(co, s, { id: `t${id}`, type: 'text-start' });
    for (const delta of s.text(step)) {
      await emit(co, s, { delta, id: `t${id}`, type: 'text-delta' });
    }
    await emit(co, s, { id: `t${id}`, type: 'text-end' });
    if (step < s.steps - 1) {
      const toolCallId = `call_${id}`;
      const input = JSON.stringify({ path: `${s.runId}-${step}.ts` });
      const half = Math.ceil(input.length / 2);
      await emit(co, s, { toolCallId, toolName: 'read_file', type: 'tool-input-start' });
      await emit(co, s, {
        inputTextDelta: input.slice(0, half),
        toolCallId,
        type: 'tool-input-delta',
      });
      await emit(co, s, {
        inputTextDelta: input.slice(half),
        toolCallId,
        type: 'tool-input-delta',
      });
      await emit(co, s, {
        input: JSON.parse(input) as unknown,
        toolCallId,
        toolName: 'read_file',
        type: 'tool-input-available',
      });
      await sleep(5); // the read_file tool
      await emit(co, s, {
        output: { content: `contents of ${s.runId}-${step}.ts` },
        toolCallId,
        type: 'tool-output-available',
      });
    }
    await emit(co, s, { type: 'finish-step' });
  }
  await emit(co, s, { type: 'finish' });
  await co.appendNow(s.threadId, { runId: s.runId, status: 'completed', type: 'run.finished' });
}

/** Unique, ordered tokens so every displayed delta is identifiable in the log (M0-A1 kill-host). */
export const tokens = (tag: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `<${tag}:${i}>`);
