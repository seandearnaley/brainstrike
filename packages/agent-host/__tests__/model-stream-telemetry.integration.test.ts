/**
 * The model's text and reasoning stream is live telemetry, never committed
 * rows (ADR-0011 amendment): `model.step` messages are the one durable owner
 * of a step's text. Committing every delta made the host DB 598 MB against
 * legacy's 44 MB at 1,000x5. A user's Stop mid-step still keeps the partial
 * reply, as legacy did: Core commits what it observed as the run's messages.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import type { LanguageModel } from 'ai';
import { afterEach, expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostLogRow, HostRunTelemetry } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { foldHostRuns } from '../src/thread-view.js';
import { scriptedModel, scriptedPartialThenHeld } from './fixtures/scripted-model.js';

const roots: string[] = [];
const hosts: AgentHost[] = [];
const clients: HostClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const MODEL_STREAM_TYPES = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
]);

async function connected(model: LanguageModel): Promise<HostClient> {
  const root = await mkdtemp(join(tmpdir(), 'bs-model-stream-telemetry-'));
  roots.push(root);
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      maxSteps: 3,
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: {},
    }
  );
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  return client;
}

function chunkTypes(rows: readonly HostLogRow[]): string[] {
  return rows.flatMap(({ event }) =>
    event.type === 'stream.chunk' &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk)
      ? [String(event.chunk['type'])]
      : []
  );
}

async function settled(client: HostClient, threadId: string): Promise<readonly HostLogRow[]> {
  await expect
    .poll(async () =>
      (await client.request('thread/read', { fromSeq: 0, threadId })).rows.some(
        ({ event }) => event.type === 'run.finished'
      )
    )
    .toBe(true);
  return (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
}

test('a run commits no text rows while its subscribers receive the text live', async () => {
  const client = await connected(scriptedModel());
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const telemetry: HostRunTelemetry[] = [];
  client.onTelemetry((received) => telemetry.push(received));
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Answer',
    threadId,
  });

  const rows = await settled(client, threadId);
  const committed = chunkTypes(rows);
  expect(committed.filter((type) => MODEL_STREAM_TYPES.has(type))).toEqual([]);
  // Notices, billing, ledger counts and projection step keys still read these.
  expect(committed).toEqual(expect.arrayContaining(['start-step', 'finish-step']));
  expect(
    telemetry
      .filter((received) => received.runId === runId)
      .map(({ chunk }) => (chunk as { type: string }).type)
  ).toEqual(['text-start', 'text-delta', 'text-end']);
  expect(telemetry.every((received) => received.toolCallId === undefined)).toBe(true);
  // The committed `model.step` owns the step's text.
  expect(foldHostRuns(rows)[0]?.text).toBe('Host run completed.');
});

test("a view that opens a running thread is replayed the open step's text", async () => {
  const partial = 'REPLAYED_PARTIAL_4417 ';
  const client = await connected(scriptedPartialThenHeld(partial));
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const live: string[] = [];
  client.onTelemetry(({ chunk }) => {
    const { text, type } = chunk as { text?: string; type: string };
    if (type === 'text-delta' && text) {
      live.push(text);
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Answer slowly',
    threadId,
  });
  await expect.poll(() => live.join('')).toBe(partial);

  const host = hosts.at(-1);
  if (!host) {
    throw new Error('The host is not running');
  }
  const late = await attachAgentHost(host.record);
  clients.push(late);
  const opened = await late.request('log/subscribe', { fromSeq: 0, threadId });
  expect(opened.telemetry).toEqual([
    { chunk: { id: 'text-1', type: 'text-start' }, ordinal: 0, runId, threadId },
    { chunk: { id: 'text-1', text: partial, type: 'text-delta' }, ordinal: 1, runId, threadId },
  ]);

  await client.request('run/stop', { commandId: randomUUID(), runId, threadId });
  await settled(client, threadId);
  // The partial committed with the Stop: a view opened now is replayed nothing.
  expect((await late.request('log/subscribe', { fromSeq: 0, threadId })).telemetry).toEqual([]);
});

test('a Stop mid-step keeps the partial text in the committed run', async () => {
  const partial = 'PARTIAL_ANSWER_1723 ';
  const client = await connected(scriptedPartialThenHeld(partial));
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const live: string[] = [];
  client.onTelemetry(({ chunk }) => {
    const { text, type } = chunk as { text?: string; type: string };
    if (type === 'text-delta' && text) {
      live.push(text);
    }
  });
  await client.request('log/subscribe', { fromSeq: 0, threadId });
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Answer slowly',
    threadId,
  });
  await expect.poll(() => live.join('')).toBe(partial);

  await client.request('run/stop', { commandId: randomUUID(), runId, threadId });

  const rows = await settled(client, threadId);
  const finished = rows.find(({ event }) => event.type === 'run.finished')?.event;
  expect(finished?.type === 'run.finished' ? finished.outcome : undefined).toBe('stopped');
  expect(chunkTypes(rows).filter((type) => MODEL_STREAM_TYPES.has(type))).toEqual([]);
  expect(
    rows.flatMap(({ event }) => (event.type === 'model.messages' ? event.messages : []))
  ).toEqual([{ content: [{ text: partial, type: 'text' }], role: 'assistant' }]);
  expect(foldHostRuns(rows)[0]?.text).toBe(partial);
});
