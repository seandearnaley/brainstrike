/**
 * A committed thread view reconnecting to its host (BST-1945, test 1):
 * it resubscribes from the last applied seq, so only the gap replays, with no
 * duplicates, and its fold equals a fresh fold. An approval that became
 * pending while it was disconnected is visible, because it comes from the log.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { CommittedThreadSession } from '../src/thread-view.js';
import { scriptedModel } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function attach(host: AgentHost): Promise<HostClient> {
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

/** A client whose `log/subscribe` requests and replies are recorded. */
function recording(client: HostClient) {
  const subscribes: { fromSeq: number; replayed: readonly number[] }[] = [];
  const recorded: HostClient = {
    ...client,
    request: (async (method: string, params: unknown) => {
      const result = await client.request(method as never, params as never);
      if (method === 'log/subscribe') {
        subscribes.push({
          fromSeq: (params as { fromSeq: number }).fromSeq,
          replayed: (result as { rows: readonly HostLogRow[] }).rows.map((row) => row.seq),
        });
      }
      return result;
    }) as HostClient['request'],
  };
  return { recorded, subscribes };
}

const seqs = (rows: readonly HostLogRow[]): number[] => rows.map((row) => row.seq);

test('a reconnected view replays only the gap, equals a fresh fold, and shows a pending approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-thread-view-reconnect-'));
  roots.push(root);
  let model: MockLanguageModelV4 = scriptedModel();
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveModel: async () => model,
      tools: {
        write_file: {
          description: 'Write an owned fixture file',
          execute: async () => ({ written: true }),
          identity: 'native-fixture-generation-1',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    }
  );
  hosts.push(host);
  const first = recording(await attach(host));
  const { threadId } = await first.recorded.request('thread/start', { commandId: randomUUID() });
  const session = new CommittedThreadSession(first.recorded, threadId);
  session.connect();
  const { runId: answered } = await first.recorded.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Answer once',
    threadId,
  });
  await expect
    .poll(() =>
      session
        .getSnapshot()
        .rows.some(({ event }) => event.type === 'run.finished' && event.runId === answered)
    )
    .toBe(true);
  const applied = session.getSnapshot().rows.at(-1)?.seq ?? 0;

  // The connection closes; meanwhile another client commits a run that waits on an approval.
  await first.recorded.close();
  await expect.poll(() => session.getSnapshot().connected).toBe(false);
  model = scriptedModel('write_file');
  const other = await attach(host);
  await other.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Write the fixture',
    threadId,
  });
  let committed: HostLogRow[] = [];
  await expect
    .poll(async () => {
      committed = (await other.request('thread/read', { fromSeq: 0, threadId })).rows;
      return committed.some(({ event }) => event.type === 'interaction.requested');
    })
    .toBe(true);
  // The paused run's stream settles: two consecutive reads of the log agree.
  let previous = -1;
  await expect
    .poll(async () => {
      committed = (await other.request('thread/read', { fromSeq: 0, threadId })).rows;
      const settled = committed.length === previous;
      previous = committed.length;
      return settled;
    })
    .toBe(true);

  const second = recording(await attach(host));
  session.reconnect(second.recorded);
  // Caught up with the whole committed log, including rows committed during the replay.
  await expect
    .poll(async () => {
      committed = (await other.request('thread/read', { fromSeq: 0, threadId })).rows;
      return seqs(session.getSnapshot().rows).at(-1) === committed.at(-1)?.seq;
    })
    .toBe(true);
  expect(session.getSnapshot().connected).toBe(true);
  // Only the gap replayed: the subscribe started at the last applied seq.
  expect(second.subscribes).toHaveLength(1);
  expect(second.subscribes[0]?.fromSeq).toBe(applied);
  expect(second.subscribes[0]?.replayed[0]).toBe(applied + 1);
  // No duplicates: one contiguous run of seqs from 1.
  expect(seqs(session.getSnapshot().rows)).toEqual(
    Array.from({ length: committed.length }, (_value, index) => index + 1)
  );
  // The fold equals a fresh fold of the same log.
  const fresh = new CommittedThreadSession(second.recorded, threadId);
  fresh.connect();
  await expect.poll(() => seqs(fresh.getSnapshot().rows).at(-1)).toBe(committed.at(-1)?.seq);
  expect(session.getSnapshot().rows).toEqual(fresh.getSnapshot().rows);
  // The approval that became pending while disconnected is visible from the log.
  const events = session.getSnapshot().rows.map(({ event }) => event.type);
  expect(events).toContain('interaction.requested');
  expect(events).not.toContain('interaction.responded');
});
