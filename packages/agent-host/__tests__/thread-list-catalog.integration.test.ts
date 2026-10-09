/**
 * `thread/list` carries each thread's catalog facts from what Core already
 * holds: the store's first and latest append times, the workspace binding and
 * the latest root run. A restart lists the same facts.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { stream, text } from './fixtures/child-run-host.js';

const TERMINAL_POLL = { interval: 50, timeout: 30_000 };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const platform: HostPlatform = {
  close: async () => undefined,
  maxSteps: 3,
  readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  resolveModel: async () =>
    new MockLanguageModelV4({ doStream: async () => stream(text('All done.')) }),
  tools: {},
};

async function listed(client: HostClient) {
  const { threads } = await client.request('thread/list', {});
  return [...threads].sort((left, right) => left.threadId.localeCompare(right.threadId));
}

test("thread/list carries each thread's dates, binding and latest run, and a restart lists the same", async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-thread-list-catalog-'));
  roots.push(root);
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  let before: Awaited<ReturnType<typeof listed>>;
  let bound: string;
  let ran: string;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    ({ threadId: bound } = await client.request('thread/start', { commandId: randomUUID() }));
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { forgePrWatch: false },
      threadId: bound,
    });
    ({ threadId: ran } = await client.request('thread/start', { commandId: randomUUID() }));
    const { runId } = await client.request('run/start', {
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Answer briefly.',
      threadId: ran,
    });
    const read = (threadId: string) => client?.request('thread/read', { fromSeq: 0, threadId });
    await expect
      .poll(
        async () =>
          (await read(ran))?.rows.some(
            ({ event }) => event.type === 'run.finished' && event.runId === runId
          ),
        TERMINAL_POLL
      )
      .toBe(true);
    before = await listed(client);
    const byId = new Map(before.map((thread) => [thread.threadId, thread]));
    for (const threadId of [bound, ran]) {
      const rows = (await read(threadId))?.rows ?? [];
      expect(byId.get(threadId)).toMatchObject({
        createdAt: rows[0]?.ts,
        updatedAt: rows.at(-1)?.ts,
      });
    }
    expect(byId.get(bound)).toMatchObject({ binding: { forgePrWatch: false } });
    expect(byId.get(bound)).not.toHaveProperty('latestRun');
    expect(byId.get(ran)).toMatchObject({
      binding: null,
      latestRun: { completedAt: expect.any(Number), needsInput: false, status: 'completed' },
    });
  } finally {
    await client?.close();
    await host?.close();
  }
  host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  try {
    client = await attachAgentHost(host.record);
    expect(await listed(client)).toEqual(before);
  } finally {
    await client?.close();
    await host.close();
  }
});
