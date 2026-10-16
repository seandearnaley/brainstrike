import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// Explicit recording from real SDK -> socket -> writer-worker SQLite -> replay
// of two runs on one thread that end without writing an answer. The first
// calls a tool, then its last step only reasons: it COMPLETES with no text, as
// a delegated child does when it stops before its summary (the host reports
// such a child `no-answer`). The second's steps stream nothing at all, which
// the host's empty-response guard retries and then FAILS. The model is
// scripted; no live provider.
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 1, text: 0, total: 1 },
};
const steps = [
  [
    { type: 'stream-start', warnings: [] },
    {
      input: '{"path":"README.md"}',
      toolCallId: 'call_answerless_1',
      toolName: 'read_fixture',
      type: 'tool-call',
    },
    { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
  ],
  [
    { type: 'stream-start', warnings: [] },
    { id: 'reasoning-1', type: 'reasoning-start' },
    { delta: 'That is everything I needed.', id: 'reasoning-1', type: 'reasoning-delta' },
    { id: 'reasoning-1', type: 'reasoning-end' },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ],
  [
    { type: 'stream-start', warnings: [] },
    { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
  ],
];
let step = 0;
const model = new MockLanguageModelV4({
  doStream: async () => {
    const chunks = steps[step] ?? steps.at(-1);
    step += 1;
    return { stream: simulateReadableStream({ chunks, initialDelayInMs: null }) };
  },
});
const root = await mkdtemp(join(tmpdir(), 'bs-record-answerless-'));
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
  let finished = Promise.withResolvers();
  client.onEvent((row) => {
    if (row.event.type === 'run.finished') {
      finished.resolve();
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  for (const prompt of ['Read the fixture, then report it.', 'Anything else?']) {
    await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt,
      threadId,
    });
    await finished.promise;
    finished = Promise.withResolvers();
  }
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  await writeFile(
    new URL(
      import.meta.resolve('@brainstrike/test-utils/fixtures/committed-host-answerless-runs.json')
    ),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
