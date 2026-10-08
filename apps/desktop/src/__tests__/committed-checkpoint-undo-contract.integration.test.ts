// @vitest-environment node

/**
 * Public-client contract for checkpoint undo in committed host mode (BST-1929,
 * #3543 6054394054 item 2, step 3).
 *
 * Today a host run's file edit reaches the legacy edit-checkpoint journal in
 * Main's PGlite, keyed by host thread/run IDs
 * (production-desktop-capabilities.ts injects them as `runtimeData.memory`).
 * But no turn-start snapshot is ever taken for a host run: the bracket
 * controller runs only on the legacy POST path (assistant-server.ts). So the
 * existing undo engine reports every host-run entry as unavailable, and the
 * committed surface mounts no checkpoint provider. These tests state, through
 * the public host client, what the committed client needs from Studio. They
 * are `test.fails` until the contract lands.
 *
 * Requested shapes (Studio owns the final names, and the platform capability
 * this fixture will then pass):
 * - a committed attribution event per file edit (`workspace.edit.recorded`):
 *   tool call, root, path, op, before/after identity;
 * - a host command `checkpoint/revert` that restores the run's paths to its
 *   turn-start snapshot, refuses while the thread has an active run, and
 *   commits the outcome (`workspace.edit.reverted`).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  attachAgentHost,
  type HostClient,
  type HostLogRow,
  startAgentHost,
} from '@brainstrike/agent-host';
import { scriptedModel } from '@brainstrike/agent-host/test-fixtures/scripted-model';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** A request the installed protocol does not define yet; Studio owns its final shape. */
type ProposedRequest = (
  method: string,
  params: Readonly<Record<string, unknown>>
) => Promise<unknown>;

const ORIGINAL = 'turn-start content';

/** A thread whose first run is paused on the default `edit:ask` approval of a file write. */
async function pausedEdit() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-checkpoint-undo-'));
  roots.push(root);
  const file = join(root, 'permitted.txt');
  await writeFile(file, ORIGINAL);
  const model = scriptedModel('write_file');
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: {
        write_file: {
          description: 'Write an owned fixture file',
          execute: async (input: unknown) => {
            await writeFile(file, z.object({ text: z.string() }).parse(input).text);
            return { path: file };
          },
          identity: 'native-fixture-generation-1',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Edit the permitted file',
    threadId,
  });
  const rows = await rowsUntil(
    client,
    threadId,
    (row) => row.event.type === 'interaction.requested'
  );
  const requested = rows.find((row) => row.event.type === 'interaction.requested')?.event;
  if (requested?.type !== 'interaction.requested') {
    throw new Error('The file write did not pause for approval');
  }
  return { client, file, requested, runId, threadId };
}

async function rowsUntil(
  client: HostClient,
  threadId: string,
  done: (row: HostLogRow) => boolean
): Promise<readonly HostLogRow[]> {
  let rows: readonly HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some(done);
    })
    .toBe(true);
  return rows;
}

/** Approve the paused write and wait for the run to finish with the edit on disk. */
async function finishedEdit() {
  const paused = await pausedEdit();
  await paused.client.request('interaction/respond', {
    commandId: randomUUID(),
    decision: 'approve',
    interactionId: paused.requested.interactionId,
    runId: paused.runId,
    threadId: paused.threadId,
  });
  const rows = await rowsUntil(
    paused.client,
    paused.threadId,
    (row) => row.event.type === 'run.finished' && row.event.runId === paused.runId
  );
  return { ...paused, rows };
}

/** Event types beyond the installed union are read as plain strings. */
function eventsOfType(rows: readonly HostLogRow[], type: string) {
  return rows.filter((row) => {
    const name: string = row.event.type;
    return name === type;
  });
}

// Control: the setup reaches today's committed effect boundary with the edit on disk.
test('a host run commits its approved file edit as an effect, with the new content on disk', async () => {
  const edited = await finishedEdit();
  expect(eventsOfType(edited.rows, 'effect.finished')).toHaveLength(1);
  expect(await readFile(edited.file, 'utf8')).toBe('written by permitted host tool');
});

test.fails('the committed log attributes the edit, and a host revert restores the run’s file to turn start once', async () => {
  const edited = await finishedEdit();
  const started = eventsOfType(edited.rows, 'effect.started')[0]?.event;
  expect(eventsOfType(edited.rows, 'workspace.edit.recorded')).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({
        runId: edited.runId,
        toolCallId: started && 'toolCallId' in started ? started.toolCallId : undefined,
      }),
    }),
  ]);
  const request = edited.client.request.bind(edited.client) as unknown as ProposedRequest;
  await request('checkpoint/revert', {
    commandId: randomUUID(),
    runId: edited.runId,
    threadId: edited.threadId,
  });
  expect(await readFile(edited.file, 'utf8')).toBe(ORIGINAL);
  const rows = await rowsUntil(
    edited.client,
    edited.threadId,
    (row) => row.event.type === ('workspace.edit.reverted' as string)
  );
  expect(eventsOfType(rows, 'workspace.edit.reverted')).toHaveLength(1);
});

test.fails('a host revert is refused while the thread’s run is active, leaving the file untouched', async () => {
  const paused = await pausedEdit();
  const request = paused.client.request.bind(paused.client) as unknown as ProposedRequest;
  await expect(
    request('checkpoint/revert', {
      commandId: randomUUID(),
      runId: paused.runId,
      threadId: paused.threadId,
    })
  ).rejects.toThrow(/active run/i);
  expect(await readFile(paused.file, 'utf8')).toBe(ORIGINAL);
});
