/**
 * run/steer (the legacy BST-588 behaviour) through the public client and a
 * real host: a steered run ends gracefully at its next step boundary, after
 * the step in flight, so the client's steer message can start the next turn.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

type Chunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer C>
    ? C
    : never;

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

/**
 * The first call streams a read tool call once `gate` opens; every later call
 * answers in text. An unsteered run therefore makes two model calls.
 */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-run-steer-'));
  roots.push(root);
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        const chunks: Chunk[] = [
          { type: 'stream-start', warnings: [] },
          {
            input: JSON.stringify({ name: 'plan' }),
            toolCallId: 'steer-read-1',
            toolName: 'read_note',
            type: 'tool-call',
          },
          { finishReason: { raw: 'tool_calls', unified: 'tool-calls' }, type: 'finish', usage },
        ];
        return {
          stream: new ReadableStream<Chunk>({
            async start(controller) {
              await gate.promise;
              for (const chunk of chunks) {
                controller.enqueue(chunk);
              }
              controller.close();
            },
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'text-1', type: 'text-start' },
            { delta: `answer ${calls}`, id: 'text-1', type: 'text-delta' },
            { id: 'text-1', type: 'text-end' },
            { finishReason: { raw: 'stop', unified: 'stop' }, type: 'finish', usage },
          ],
          initialDelayInMs: null,
        }),
      };
    },
  });
  const reads: string[] = [];
  const platform: HostPlatform = {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      read_note: {
        description: 'Read an owned note',
        execute: async (input) => {
          const { name } = z.object({ name: z.string() }).parse(input);
          reads.push(name);
          return { note: `note ${name}` };
        },
        identity: 'native-fixture-read-1',
        inputSchema: z.object({ name: z.string() }),
        risk: 'read',
      },
    },
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  hosts.push(host);
  const client = await attachAgentHost(host.record);
  clients.push(client);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  return { client, gate, model, reads, threadId };
}

async function finished(
  client: HostClient,
  threadId: string,
  runId: string
): Promise<HostLogRow['event']> {
  let event: HostLogRow['event'] | undefined;
  await expect
    .poll(async () => {
      const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
      event = rows.find(
        (row) => row.event.type === 'run.finished' && row.event.runId === runId
      )?.event;
      return event !== undefined;
    })
    .toBe(true);
  if (!event) {
    throw new Error('The run did not finish');
  }
  return event;
}

test('a steered run completes its step in flight, then ends before another model call', async () => {
  const { client, gate, model, reads, threadId } = await setup();
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Read the plan note, then summarise it.',
    threadId,
  });
  await expect.poll(() => model.doStreamCalls.length).toBe(1);
  const commandId = randomUUID();
  expect(await client.request('run/steer', { commandId, runId, threadId })).toEqual({
    outcome: 'steering',
  });
  gate.resolve();

  expect(await finished(client, threadId, runId)).toMatchObject({ outcome: 'completed' });
  // The step in flight ran its tool; no further step asked the model again.
  expect(reads).toEqual(['plan']);
  expect(model.doStreamCalls).toHaveLength(1);
  // A finished run is not steered again, and a repeated command answers the same.
  expect(await client.request('run/steer', { commandId: randomUUID(), runId, threadId })).toEqual({
    outcome: 'already-terminal',
  });
  expect(await client.request('run/steer', { commandId, runId, threadId })).toEqual({
    outcome: 'steering',
  });
});

test('an unsteered run takes its next step', async () => {
  const { client, gate, model, threadId } = await setup();
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Read the plan note, then summarise it.',
    threadId,
  });
  gate.resolve();
  expect(await finished(client, threadId, runId)).toMatchObject({ outcome: 'completed' });
  expect(model.doStreamCalls).toHaveLength(2);
});
