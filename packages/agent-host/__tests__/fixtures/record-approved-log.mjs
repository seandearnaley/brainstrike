import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { z } from 'zod';
import { attachAgentHost, startAgentHost } from '../../dist/index.js';

// Explicit recording from real SDK -> socket -> writer-worker SQLite -> replay.
// This owned fixture uses a scripted model and never invokes a live provider.
// The same run's live `run/telemetry` (the model's text stream, never
// committed: ADR-0011 amendment) is recorded beside its committed rows.
const root = await mkdtemp(join(tmpdir(), 'bs-m3-record-'));
const host = await startAgentHost(
  { lifetime: 'persistent', root },
  {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({
      policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'allow' },
      yolo: false,
    }),
    resolveModel: async () => scriptedModel('write_file'),
    tools: {
      write_file: {
        description: 'Write an owned fixture file',
        execute: async (input) => {
          const { text } = z.object({ text: z.string() }).parse(input);
          await writeFile(join(root, 'permitted.txt'), text);
          return { path: join(root, 'permitted.txt') };
        },
        identity: 'native-fixture-generation-1',
        inputSchema: z.object({ text: z.string() }),
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
  const telemetry = [];
  client.onTelemetry((received) => {
    if (received.threadId === threadId) {
      telemetry.push(received);
    }
  });
  // The decision is answered once its step has committed, as a person answers
  // the approval the view shows, so the row order never depends on a race.
  let requested;
  client.onEvent((row) => {
    if (row.event.type === 'interaction.requested') {
      requested = row.event;
    }
    if (requested && row.event.type === 'stream.chunk' && row.event.chunk?.type === 'finish-step') {
      const { interactionId, runId } = requested;
      requested = undefined;
      client
        .request('interaction/respond', {
          commandId: randomUUID(),
          decision: 'approve',
          interactionId,
          runId,
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
    prompt: 'Use the fixture tool, then report the result.',
    threadId,
  });
  await Promise.all([finished.promise, responded.promise]);
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  await writeFile(
    new URL(
      import.meta.resolve('@brainstrike/test-utils/fixtures/committed-approved-host-run.json')
    ),
    `${JSON.stringify(rows, null, 2)}\n`
  );
  await writeFile(
    new URL(
      import.meta.resolve(
        '@brainstrike/test-utils/fixtures/committed-approved-host-run-telemetry.json'
      )
    ),
    `${JSON.stringify(telemetry, null, 2)}\n`
  );
  process.stdout.write(
    `Recorded ${rows.length} committed rows and ${telemetry.length} telemetry chunks\n`
  );
} finally {
  await client.close();
  await host.close();
  await rm(root, { force: true, recursive: true });
}
