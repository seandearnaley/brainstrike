import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { HostCore } from '../../dist/core.js';

// Explicit recording from the real SDK -> HostCore -> SQLite of one thread with
// two runs: a run whose first attempt stalls after partial text and recovers,
// with a provider call warning on each attempt; and a run whose stall after
// streamed tool input is refused. The model is scripted; no live provider.
// Usage: node record-attempt-log.mjs <output.json>
const output = process.argv[2];
if (!output) {
  throw new Error('Usage: node record-attempt-log.mjs <output.json>');
}
Object.assign(process.env, {
  BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS: '600',
  BRAINSTRIKE_STREAM_INACTIVITY_MS: '400',
  BRAINSTRIKE_STREAM_REASONING_GAP_MS: '600',
  BRAINSTRIKE_STREAM_STALL_ATTEMPTS: '2',
  BRAINSTRIKE_TOOL_CALL_INPUT_MS: '800',
});
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
// The adapter's report for a setting the model rejects (BST-1701 field shape).
const warnings = [
  {
    details: 'temperature is not supported for reasoning models',
    feature: 'temperature',
    type: 'unsupported',
  },
];
const text = (delta) => [
  { id: 'text-1', type: 'text-start' },
  { delta, id: 'text-1', type: 'text-delta' },
];
const scripts = [
  // Run 1, attempt 1: partial text, then silence.
  [...text('Partial')],
  // Run 1, attempt 2: a complete answer.
  [
    ...text('Recovered answer.'),
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ],
  // Run 2: streamed tool input, then silence.
  [
    { id: 'call-1', toolName: 'probe', type: 'tool-input-start' },
    { delta: '{"text":', id: 'call-1', type: 'tool-input-delta' },
  ],
];
let call = 0;
const model = new MockLanguageModelV4({
  doStream: async ({ abortSignal }) => {
    const chunks = scripts[call] ?? [];
    call += 1;
    return {
      stream: new ReadableStream({
        start(controller) {
          abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason), {
            once: true,
          });
          controller.enqueue({ type: 'stream-start', warnings });
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          if (chunks.some((chunk) => chunk.type === 'finish')) {
            controller.close();
          }
        },
      }),
    };
  },
});
const root = await mkdtemp(join(tmpdir(), 'bs-m3-record-attempts-'));
const store = await StateStore.open(root);
const core = await HostCore.open(
  store,
  {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () => model,
    tools: {
      probe: {
        description: 'Read-only probe',
        execute: async () => ({ seen: true }),
        identity: 'probe-identity',
        inputSchema: z.object({ text: z.string() }),
        risk: 'read',
      },
    },
  },
  () => () => undefined
);
try {
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const settle = async (runId) => {
    for (;;) {
      const rows = await core.read(threadId, 0);
      if (rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId)) {
        return;
      }
      await sleep(25);
    }
  };
  for (const prompt of ['Answer after a stall.', 'Call the probe.']) {
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt,
      threadId,
    });
    await settle(runId);
  }
  await writeFile(output, `${JSON.stringify(await core.read(threadId, 0), null, 2)}\n`);
} finally {
  await core.close();
  await store.close();
  await rm(root, { force: true, recursive: true });
}
