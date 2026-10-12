/**
 * Host auto-titles: the first completed run of an untitled thread asks the
 * run's own model for a title and commits it as `thread.updated`. A user
 * rename always wins, and a titled thread is never retitled.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Streams `answer` for runs; answers title requests from `title()`. */
function titledModel(title: () => Promise<string>) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: await title(), type: 'text' }],
      finishReason: { raw: 'stop', unified: 'stop' },
      usage,
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'text-1', type: 'text-start' },
          { delta: 'answer', id: 'text-1', type: 'text-delta' },
          { id: 'text-1', type: 'text-end' },
          { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
}

async function open(root: string, model: MockLanguageModelV4) {
  const platform: HostPlatform = {
    close: async () => undefined,
    generatesThreadTitles: true,
    maxSteps: 2,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {},
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

async function titleOf(client: HostClient, threadId: string): Promise<string | undefined> {
  const { threads } = await client.request('thread/list', {});
  return threads.find((thread) => thread.threadId === threadId)?.title;
}

async function completed(client: HostClient, threadId: string, prompt: string): Promise<void> {
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt,
    threadId,
  });
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.find(({ event }) => event.type === 'run.finished' && event.runId === runId)
        ?.event;
    })
    .toMatchObject({ outcome: 'completed' });
}

test('the first completed run titles an untitled thread once, and the title survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const model = titledModel(async () => '"Release rollback plan"\n');
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  await completed(client, threadId, 'Plan a rollback for the release');
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');
  // The title request carries the user's first message through the run's model.
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain(
    'Plan a rollback for the release'
  );

  // A titled thread is never retitled.
  await completed(client, threadId, 'Add an owner to each step');
  expect(model.doGenerateCalls).toHaveLength(1);
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  expect(rows.filter(({ event }) => event.type === 'thread.updated')).toHaveLength(1);

  await client.close();
  await hosts.at(-1)?.close();
  const restarted = await open(root, model);
  expect(await titleOf(restarted, threadId)).toBe('Release rollback plan');
});

test('a user rename made while the title is generating wins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  const model = titledModel(() => {
    requested.resolve();
    return release.promise;
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const run = completed(client, threadId, 'Plan a rollback for the release');
  await requested.promise;
  await client.request('thread/update', { commandId: randomUUID(), threadId, title: 'Mine' });
  release.resolve('Generated title');
  await run;
  // The generated title never replaces the user's.
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.flatMap(({ event }) => (event.type === 'thread.updated' ? [event.title] : []));
    })
    .toEqual(['Mine']);
  expect(await titleOf(client, threadId)).toBe('Mine');
});
