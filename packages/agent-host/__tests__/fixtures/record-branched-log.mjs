import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { committedRunIdentity } from '../../dist/committed-identities.js';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// Explicit recording from real SDK -> socket -> writer-worker SQLite -> replay of
// a branched thread: First, Second, a regenerated Second, and an edited Second.
// The model is scripted (a distinct answer per call); no live provider is used.
// Identities are the real committedRunIdentity of each recorded run.
let calls = 0;
const model = new MockLanguageModelV4({
  doStream: async () => {
    const call = calls;
    calls += 1;
    return {
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'text-1', type: 'text-start' },
          { delta: `Recorded answer ${call}.`, id: 'text-1', type: 'text-delta' },
          { id: 'text-1', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    };
  },
});
const root = await mkdtemp(join(tmpdir(), 'bs-m3-record-branches-'));
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
    tools: {},
  }
);
const client = await attachAgentHost(host.record);
try {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const settle = async (runId) => {
    for (;;) {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      if (rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId)) {
        return rows;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const start = async (prompt, parentMessageId) => {
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      ...(parentMessageId === undefined ? {} : { parentMessageId }),
      prompt,
      threadId,
    });
    return { rows: await settle(runId), runId };
  };
  const first = await start('Plan the release checklist.');
  const second = await start('Add a rollback step.');
  const secondUser = committedRunIdentity(second.rows, second.runId).userMessageId;
  const { runId: regenerated } = await client.request('run/regenerate', {
    commandId: randomUUID(),
    modelId: 'scripted',
    threadId,
    userMessageId: secondUser,
  });
  await settle(regenerated);
  const edited = await start('Add a rollback step with an owner.', first.runId);
  const rows = edited.rows;
  const identities = Object.fromEntries(
    [first.runId, second.runId, regenerated, edited.runId].map((runId) => [
      runId,
      { ...committedRunIdentity(rows, runId), createdAt: undefined },
    ])
  );
  for (const [runId, identity] of Object.entries(identities)) {
    identity.createdAt = committedRunIdentity(rows, runId).createdAt.toISOString();
  }
  await writeFile(
    new URL(
      '../../../assistant-ui/src/__tests__/fixtures/committed-host-branches.json',
      import.meta.url
    ),
    `${JSON.stringify({ identities, rows }, null, 2)}\n`
  );
  process.stdout.write(`Recorded ${rows.length} committed rows over 4 branched runs\n`);
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
