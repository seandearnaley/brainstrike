import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { RunHost, type HostOptions, type RunCtx, type ToolMeta } from '../src/host.js';
import { RunEventLog } from '../src/log.js';
import { scriptedModel, sleep, type Call, type Script } from '../src/mock.js';

export interface TestHost { host: RunHost; log: RunEventLog; calls: Call[]; toolLog: Array<{ label: string; tool: string; phase: 'start' | 'end' | 'abort'; at: number; toolCallId: string }> }

/** Standard tool set: read_file (fast/slow), write_file (gated), slow_tool (abortable), progress (preliminary outputs). */
export function stdTools(run: RunCtx, host: RunHost, toolLog: TestHost['toolLog'], readMs = 50): ToolSet {
  const mark = (tool: string, phase: 'start' | 'end' | 'abort', toolCallId: string) => toolLog.push({ label: run.label, tool, phase, at: performance.now(), toolCallId });
  return {
    read_file: tool({
      description: 'Read a file', inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }, { toolCallId, abortSignal }) => {
        mark('read_file', 'start', toolCallId);
        try { await sleep(readMs, abortSignal); } catch (e) { mark('read_file', 'abort', toolCallId); throw e; }
        mark('read_file', 'end', toolCallId);
        return { path, content: `contents of ${path}` };
      },
    }),
    write_file: tool({
      description: 'Write a file (requires approval)', inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path }, { toolCallId, abortSignal }) => {
        mark('write_file', 'start', toolCallId);
        const decision = await run.gate(toolCallId, 'write_file', { path }, abortSignal);
        if (decision === 'deny') { mark('write_file', 'end', toolCallId); return { written: false, denied: true, path }; }
        host.recordEffect(run, 'write_file', toolCallId);
        mark('write_file', 'end', toolCallId);
        return { written: true, path, decision };
      },
    }),
    slow_tool: tool({
      description: 'Slow tool', inputSchema: z.object({ ms: z.number() }),
      execute: async ({ ms }, { toolCallId, abortSignal }) => {
        mark('slow_tool', 'start', toolCallId);
        try { await sleep(ms, abortSignal); } catch (e) { mark('slow_tool', 'abort', toolCallId); throw e; }
        mark('slow_tool', 'end', toolCallId);
        return { slept: ms };
      },
    }),
    progress: tool({
      description: 'Reports progress', inputSchema: z.object({ steps: z.number() }),
      async *execute({ steps }, { abortSignal }) {
        for (let i = 1; i <= steps; i++) { await sleep(5, abortSignal); yield { done: i, of: steps, final: i === steps }; }
      },
    }),
  };
}

export const STD_META: Record<string, ToolMeta> = {
  read_file: { risk: 'read' }, write_file: { risk: 'mutate', approval: true }, slow_tool: { risk: 'mutate' }, progress: { risk: 'read' },
};

export async function makeHost(script: Script, opts: Partial<HostOptions> & { chunkDelayMs?: number; dataDir?: string; readMs?: number; log?: RunEventLog } = {}): Promise<TestHost> {
  const log = opts.log ?? (await RunEventLog.open(opts.dataDir));
  const calls: Call[] = [];
  const toolLog: TestHost['toolLog'] = [];
  // eslint-disable-next-line prefer-const
  let host: RunHost;
  host = new RunHost({
    log,
    model: (run) => scriptedModel(script, { label: run.label, calls, chunkDelayMs: opts.chunkDelayMs }),
    tools: (run) => stdTools(run, host, toolLog, opts.readMs),
    toolMeta: (n) => STD_META[n],
    ...opts,
  });
  return { host, log, calls, toolLog };
}

/** Every tool-call in a model prompt has a matching tool-result. */
export function promptIsWellFormed(promptText: string): { calls: string[]; results: string[]; ok: boolean } {
  const prompt = JSON.parse(promptText) as Array<{ role: string; content: unknown }>;
  const calls: string[] = []; const results: string[] = [];
  for (const m of prompt) if (Array.isArray(m.content)) for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
    if (p.type === 'tool-call') calls.push(p.toolCallId!);
    if (p.type === 'tool-result') results.push(p.toolCallId!);
  }
  return { calls, results, ok: calls.every((c) => results.includes(c)) };
}
export const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN; };
