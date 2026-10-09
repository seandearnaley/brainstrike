import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { StateStore } from '@brainstrike/state-store';
import { HostCore } from '../../dist/core.js';
import { scriptedModel } from '../../dist/test-fixtures/scripted-model.js';

// Explicit recording from the real SDK -> HostCore -> SQLite of one thread's
// rewinds (gap 2): runs A and B; a conversation-only rewind to before B; its
// redo; a second rewind to before B; then run C, which names no parent and so
// follows the rewound tip. The model is scripted; no live provider.
// Usage: node record-rewind-log.mjs <output.json>
const output = process.argv[2];
if (!output) {
  throw new Error('Usage: node record-rewind-log.mjs <output.json>');
}
const root = await mkdtemp(join(tmpdir(), 'bs-m3-record-rewind-'));
const store = await StateStore.open(root);
const core = await HostCore.open(
  store,
  {
    close: async () => undefined,
    maxSteps: 2,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () => scriptedModel(),
    tools: {},
  },
  () => () => undefined
);
try {
  const { threadId } = await core.startThread({ commandId: randomUUID() });
  const run = async (prompt) => {
    const commandId = randomUUID();
    const { runId } = await core.startRun({ commandId, modelId: 'scripted', prompt, threadId });
    for (;;) {
      const rows = await core.read(threadId, 0);
      if (rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId)) {
        return commandId;
      }
      await sleep(25);
    }
  };
  const rewind = (messageId) =>
    core.rewind({ commandId: randomUUID(), messageId, mode: 'conversation-only', threadId });
  await run('First message.');
  const second = await run('Second message.');
  const { rewindId } = await rewind(second);
  await core.redoRewind({ commandId: randomUUID(), rewindId, threadId });
  await rewind(second);
  await run('Third message, after the rewind.');
  await writeFile(output, `${JSON.stringify(await core.read(threadId, 0), null, 2)}\n`);
} finally {
  await core.close();
  await store.close();
  await rm(root, { force: true, recursive: true });
}
