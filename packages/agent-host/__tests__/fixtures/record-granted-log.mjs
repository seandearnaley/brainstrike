import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedToolSequence } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { z } from 'zod';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// Explicit recording from real SDK -> socket -> writer-worker SQLite -> replay:
// two edits in one run; the first is approved with a session grant for edits,
// so the second runs without a request. Scripted model, no live provider.
const root = await mkdtemp(join(tmpdir(), 'bs-m3-record-grant-'));
const host = await startAgentHost(
  { lifetime: 'persistent', root },
  {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () =>
      scriptedToolSequence([
        { input: { text: 'first' }, toolId: 'write_file' },
        { input: { text: 'second' }, toolId: 'write_file' },
      ]),
    tools: {
      write_file: {
        description: 'Write an owned fixture file',
        execute: async (input) => {
          const { text } = z.object({ text: z.string() }).parse(input);
          await writeFile(join(root, `${text}.txt`), text);
          return { path: join(root, `${text}.txt`) };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
        permissionToolId: 'brainstrike.writeFixture',
        risk: 'edit',
      },
    },
  }
);
const client = await attachAgentHost(host.record);
try {
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const finished = Promise.withResolvers();
  const responded = Promise.withResolvers();
  client.onEvent((row) => {
    if (row.event.type === 'interaction.requested') {
      client
        .request('interaction/respond', {
          commandId: randomUUID(),
          decision: 'approve',
          grant: { category: 'edit', scope: 'session' },
          interactionId: row.event.interactionId,
          runId: row.event.runId,
          threadId,
        })
        .then(responded.resolve, responded.reject);
    }
    if (row.event.type === 'run.finished') {
      finished.resolve();
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Write both fixture files, then report.',
    threadId,
  });
  await Promise.all([finished.promise, responded.promise]);
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  await writeFile(
    new URL('../../../test-utils/fixtures/committed-host-granted-run.json', import.meta.url),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  process.stdout.write(`Recorded ${rows.length} committed rows\n`);
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
