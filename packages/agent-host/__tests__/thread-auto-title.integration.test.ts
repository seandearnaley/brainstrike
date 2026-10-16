/**
 * Host auto-titles: the first run of an untitled thread asks the run's own
 * model to title the quoted user message beside its answer, and commits the
 * title as `thread.updated` as soon as it answers. A user rename always wins,
 * and a titled thread is never retitled.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import {
  HOST_THREAD_TITLE_INSTRUCTIONS,
  HOST_THREAD_TITLE_TIMEOUT_MS,
} from '../src/thread-presentation-state.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const stop = { raw: 'stop', unified: 'stop' } as const;
const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** Streams `answer` for runs; answers title requests from `title()`. */
function titledModel(title: () => Promise<string>) {
  return new MockLanguageModelV4({
    doGenerate: async () => titleResult(await title()),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'text-1', type: 'text-start' },
          { delta: 'answer', id: 'text-1', type: 'text-delta' },
          { id: 'text-1', type: 'text-end' },
          { finishReason: stop, type: 'finish', usage },
        ],
        initialDelayInMs: null,
      }),
    }),
  });
}

/** Streams `answer`, then holds its finish until `held` settles; a Stop errors the held stream. */
function heldStream(held: Promise<void>, abortSignal: AbortSignal | undefined) {
  return new ReadableStream<Chunk>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ id: 'text-1', type: 'text-start' });
      controller.enqueue({ delta: 'answer', id: 'text-1', type: 'text-delta' });
      controller.enqueue({ id: 'text-1', type: 'text-end' });
      const aborted = Promise.withResolvers<void>();
      abortSignal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      await Promise.race([held, aborted.promise]);
      if (abortSignal?.aborted) {
        controller.error(abortSignal.reason);
        return;
      }
      controller.enqueue({ finishReason: stop, type: 'finish', usage });
      controller.close();
    },
  });
}

function titleResult(text: string) {
  return { content: [{ text, type: 'text' as const }], finishReason: stop, usage, warnings: [] };
}

async function open(root: string, model: MockLanguageModelV4, admitRun?: HostPlatform['admitRun']) {
  const platform: HostPlatform = {
    ...(admitRun ? { admitRun } : {}),
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

async function finished(client: HostClient, threadId: string, runId: string) {
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  return rows.find(({ event }) => event.type === 'run.finished' && event.runId === runId)?.event;
}

/** The fields of every `host_thread_title_failed` warning logged from now on. */
function titleFailures(): readonly object[] {
  const failures: object[] = [];
  onTestFinished(
    addLogListener((record: LogRecord) => {
      for (const value of record.args) {
        if (
          value !== null &&
          typeof value === 'object' &&
          'code' in value &&
          value.code === 'host_thread_title_failed'
        ) {
          failures.push({ ...value });
        }
      }
    })
  );
  return failures;
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

test('the title is requested while the first run streams, not after its answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const requested = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      requested.resolve();
      return titleResult('Release rollback plan');
    },
    // The answer cannot finish until its thread's title has been requested.
    doStream: async ({ abortSignal }) => ({ stream: heldStream(requested.promise, abortSignal) }),
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  await completed(client, threadId, 'Plan a rollback for the release');
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');
  expect(model.doGenerateCalls).toHaveLength(1);
});

test('the title commits as soon as it answers, while the answer is still streaming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const answer = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Release rollback plan'),
    // The answer holds its finish until the test releases it.
    doStream: async ({ abortSignal }) => ({ stream: heldStream(answer.promise, abortSignal) }),
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');
  expect(await finished(client, threadId, runId)).toBeUndefined();

  answer.resolve();
  await expect
    .poll(() => finished(client, threadId, runId))
    .toMatchObject({ outcome: 'completed' });
  const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
  const types = rows.map(({ event }) => event.type);
  expect(types.filter((type) => type === 'thread.updated')).toHaveLength(1);
  expect(types.indexOf('thread.updated')).toBeLessThan(types.indexOf('run.finished'));
});

test('a title that arrived before the run failed stays committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const fail = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Release rollback plan'),
    // The answer fails only once the test has seen the committed title.
    doStream: async () => {
      await fail.promise;
      throw new Error('Offline answer failure');
    },
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');

  fail.resolve();
  await expect.poll(() => finished(client, threadId, runId)).toMatchObject({ outcome: 'failed' });
  expect(await titleOf(client, threadId)).toBe('Release rollback plan');
});

test("the title request quotes the user's message as material to title, not a task", async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const model = titledModel(async () => 'Release rollback plan');
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });

  await completed(client, threadId, 'Plan a rollback for the release');
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(model.doGenerateCalls[0]?.prompt).toMatchObject([
    { content: HOST_THREAD_TITLE_INSTRUCTIONS, role: 'system' },
    {
      content: [{ text: '<message>\nPlan a rollback for the release\n</message>', type: 'text' }],
      role: 'user',
    },
  ]);
  // The instructions name that framing: the message is quoted material, never a task.
  expect(HOST_THREAD_TITLE_INSTRUCTIONS).toContain('<message>');
});

test('a title that arrived before Stop is kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const model = new MockLanguageModelV4({
    doGenerate: async () => titleResult('Release rollback plan'),
    // The answer never finishes on its own: only Stop ends the run.
    doStream: async ({ abortSignal }) => ({
      stream: heldStream(new Promise<void>(() => undefined), abortSignal),
    }),
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  await expect.poll(() => model.doGenerateCalls.length).toBe(1);

  expect(await client.request('run/stop', { commandId: randomUUID(), runId, threadId })).toEqual({
    outcome: 'stopped',
  });
  // A Stop does not withdraw the user's message: its title stays.
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');
});

test("the run's admission closes only after its title request settles", async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const order: string[] = [];
  const release = Promise.withResolvers<string>();
  const model = titledModel(async () => {
    const title = await release.promise;
    order.push('title');
    return title;
  });
  const client = await open(root, model, async () => ({
    close: async () => {
      order.push('close');
    },
    configuration: {},
    generatesThreadTitle: true,
    model,
    snapshot: { configuration: {}, maxSteps: 2, toolIdentities: {} },
    tools: {},
  }));
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const run = completed(client, threadId, 'Plan a rollback for the release');
  // The answer is committed while its title is still generating.
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.some(({ event }) => event.type === 'model.step');
    })
    .toBe(true);
  release.resolve('Release rollback plan');
  await run;
  expect(order).toEqual(['title', 'close']);
  await expect.poll(() => titleOf(client, threadId)).toBe('Release rollback plan');
});

test('a silent title request holds a completed run only until its bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const failures = titleFailures();
  // The provider never answers the title, and it ignores its abort signal.
  const model = titledModel(() => new Promise<string>(() => undefined));
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  // The answer is committed while its title is outstanding.
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.some(({ event }) => event.type === 'model.step');
    })
    .toBe(true);
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(await finished(client, threadId, runId)).toBeUndefined();

  await vi.advanceTimersByTimeAsync(HOST_THREAD_TITLE_TIMEOUT_MS);
  await expect
    .poll(() => finished(client, threadId, runId))
    .toMatchObject({ outcome: 'completed' });
  expect(await titleOf(client, threadId)).toBeUndefined();
  // The expired title is visible, never silent.
  expect(failures).toEqual([
    expect.objectContaining({ runId, timeoutMs: HOST_THREAD_TITLE_TIMEOUT_MS }),
  ]);
});

test('a failed run withdraws its silent title request instead of waiting for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const failures = titleFailures();
  const requested = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    // The provider never answers the title, and it ignores its abort signal.
    doGenerate: () => {
      requested.resolve();
      return new Promise<never>(() => undefined);
    },
    // The answer fails while its title is outstanding.
    doStream: async () => {
      await requested.promise;
      throw new Error('Offline answer failure');
    },
  });
  const client = await open(root, model);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  // Real timers: the failed run finishes well inside the title's bound.
  await expect
    .poll(() => finished(client, threadId, runId), { timeout: 5000 })
    .toMatchObject({ outcome: 'failed' });
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(await titleOf(client, threadId)).toBeUndefined();
  // Withdrawing a title the run can never commit is not a title failure.
  expect(failures).toEqual([]);
});

test('a prompt its UserPromptSubmit hook blocks is never sent for a title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-auto-title-'));
  roots.push(root);
  const model = titledModel(async () => 'Release rollback plan');
  const client = await open(root, model, async () => ({
    configuration: {},
    generatesThreadTitle: true,
    hooks: {
      matchesPreToolUse: () => false,
      postToolUse: async () => ({}),
      preToolUse: async () => ({ blocked: false }),
      stop: async () => ({}),
      userPromptSubmit: async () => ({ blocked: true, reason: 'Rollback prompts are disabled' }),
    },
    model,
    snapshot: { configuration: {}, maxSteps: 2, toolIdentities: {} },
    tools: {},
  }));
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Plan a rollback for the release',
    threadId,
  });
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      return rows.find(({ event }) => event.type === 'run.finished' && event.runId === runId)
        ?.event;
    })
    .toMatchObject({ outcome: 'failed' });
  // The hook decides before the prompt reaches the model, for its title too.
  expect(model.doGenerateCalls).toHaveLength(0);
  expect(model.doStreamCalls).toHaveLength(0);
  expect(await titleOf(client, threadId)).toBeUndefined();
});
