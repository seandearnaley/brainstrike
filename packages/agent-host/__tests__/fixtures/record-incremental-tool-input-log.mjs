import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// Explicit recording from real SDK -> socket -> writer-worker SQLite -> replay
// of one run whose provider streams its tool input incrementally, as the
// OpenRouter provider does for chat-completions models (GLM, Muse, Qwen): the
// step reasons, writes text, then opens the call with an EMPTY first input
// delta (the wire's `arguments: ""`) before the argument fragments. The parts
// mirror a recorded GLM 5.3 Flash step (2026-10-16 debug pack). The model is
// scripted; no live provider.
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 1, text: 1, total: 2 },
};
const steps = [
  [
    { type: 'stream-start', warnings: [] },
    { id: 'reasoning-0', type: 'reasoning-start' },
    { delta: 'Checking the fixture first.', id: 'reasoning-0', type: 'reasoning-delta' },
    { id: 'reasoning-0', type: 'reasoning-end' },
    { id: 'text-0', type: 'text-start' },
    { delta: 'Reading the fixture now.', id: 'text-0', type: 'text-delta' },
    { id: 'text-0', type: 'text-end' },
    { id: 'call_incremental_1', toolName: 'read_fixture', type: 'tool-input-start' },
    { delta: '', id: 'call_incremental_1', type: 'tool-input-delta' },
    { delta: '{', id: 'call_incremental_1', type: 'tool-input-delta' },
    { delta: '"path":"README.md"}', id: 'call_incremental_1', type: 'tool-input-delta' },
    { id: 'call_incremental_1', type: 'tool-input-end' },
    {
      input: '{"path":"README.md"}',
      toolCallId: 'call_incremental_1',
      toolName: 'read_fixture',
      type: 'tool-call',
    },
    { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
  ],
  [
    { type: 'stream-start', warnings: [] },
    { id: 'text-1', type: 'text-start' },
    { delta: 'The fixture says hello.', id: 'text-1', type: 'text-delta' },
    { id: 'text-1', type: 'text-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ],
];
let step = 0;
const model = new MockLanguageModelV4({
  doStream: async () => {
    const chunks = steps[step] ?? steps.at(-1);
    step += 1;
    // Paced as a provider streams: each input delta commits before the call
    // that ends it starts the tool, so the view reads the deltas themselves.
    return {
      stream: simulateReadableStream({ chunkDelayInMs: 25, chunks, initialDelayInMs: null }),
    };
  },
});
const root = await mkdtemp(join(tmpdir(), 'bs-record-incremental-'));
const host = await startAgentHost(
  { lifetime: 'persistent', root },
  {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () => model,
    tools: {
      read_fixture: {
        description: 'Read an owned fixture file',
        execute: async (input) => {
          const { path } = z.object({ path: z.string() }).parse(input);
          return { content: 'hello', path };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ path: z.string() }),
        risk: 'read',
      },
    },
  }
);
const client = await attachAgentHost(host.record);
try {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const finished = Promise.withResolvers();
  client.onEvent((row) => {
    if (row.event.type === 'run.finished') {
      finished.resolve();
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Read the fixture, then report it.',
    threadId,
  });
  await finished.promise;
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  await writeFile(
    new URL(
      import.meta.resolve(
        '@brainstrike/test-utils/fixtures/committed-host-incremental-tool-input.json'
      )
    ),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
