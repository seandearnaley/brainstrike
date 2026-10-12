// Deterministic scripted models on ai/test MockLanguageModelV4.
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

export type Part = LanguageModelV4StreamPart;
export interface Call { label: string; index: number; options: LanguageModelV4CallOptions; promptText: string }
export type Script = (call: Call) => Part[];

let tc = 0;
export const text = (s: string, pieces = 4, id = `t${++tc}`): Part[] => {
  const size = Math.max(1, Math.ceil(s.length / pieces));
  const out: Part[] = [{ type: 'text-start', id }];
  for (let i = 0; i < s.length; i += size) out.push({ type: 'text-delta', id, delta: s.slice(i, i + size) });
  out.push({ type: 'text-end', id });
  return out;
};
export const reasoning = (s: string, id = `r${++tc}`): Part[] => [
  { type: 'reasoning-start', id }, { type: 'reasoning-delta', id, delta: s.slice(0, Math.ceil(s.length / 2)) }, { type: 'reasoning-delta', id, delta: s.slice(Math.ceil(s.length / 2)) }, { type: 'reasoning-end', id },
];
export const toolCall = (toolName: string, input: unknown, toolCallId = `call_${++tc}`): Part[] => {
  const json = JSON.stringify(input);
  const half = Math.ceil(json.length / 2);
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json.slice(0, half) },
    { type: 'tool-input-delta', id: toolCallId, delta: json.slice(half) },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
  ];
};

export const promptToText = (o: LanguageModelV4CallOptions) => JSON.stringify(o.prompt);

/** One shared mock; script dispatches by run label. Records every call. */
export function scriptedModel(script: Script, opts: { chunkDelayMs?: number; label: string; calls: Call[]; usage?: { input: number; output: number } }) {
  const usage = opts.usage ?? { input: 100, output: 20 };
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const call: Call = { label: opts.label, index: opts.calls.filter((c) => c.label === opts.label).length, options, promptText: promptToText(options) };
      opts.calls.push(call);
      const parts = script(call);
      const hasTool = parts.some((p) => p.type === 'tool-call');
      const all: Part[] = [{ type: 'stream-start', warnings: [] }, ...parts, {
        type: 'finish', finishReason: { unified: hasTool ? 'tool-calls' : 'stop', raw: hasTool ? 'tool_calls' : 'stop' },
        usage: { inputTokens: { total: usage.input, noCache: usage.input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: usage.output, text: usage.output, reasoning: 0 } },
      }];
      const delay = opts.chunkDelayMs ?? 0;
      let i = 0;
      const signal = options.abortSignal;
      return {
        stream: new ReadableStream<Part>({
          async pull(c) {
            if (signal?.aborted) { c.error(signal.reason ?? new Error('aborted')); return; }
            if (i >= all.length) { c.close(); return; }
            if (delay) await new Promise((r) => setTimeout(r, delay));
            c.enqueue(all[i++]!);
          },
        }),
      };
    },
  });
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(signal.reason ?? new Error('aborted'));
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason ?? new Error('aborted')); }, { once: true });
});
