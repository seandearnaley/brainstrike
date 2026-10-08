import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform, HostToolContext } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';
import { scriptedToolSequence } from '../src/test-fixtures/scripted-model.js';

const Input = z.strictObject({ key: z.string() });

function platform(seen: unknown[]): HostPlatform {
  return {
    close: async () => undefined,
    maxSteps: 4,
    readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: true }),
    resolveModel: async () =>
      scriptedToolSequence([
        { input: { key: 'counter/a' }, toolId: 'count' },
        { input: { key: 'counter/b' }, toolId: 'count' },
      ]),
    tools: {
      count: {
        description: 'Increment one counter in the thread state',
        execute: async (input: unknown, context: HostToolContext) => {
          const { key } = Input.parse(input);
          const state = context.state;
          if (!state) {
            throw new Error('Core supplied no tool state capability');
          }
          await state.update(key, (current) => (z.number().optional().parse(current) ?? 0) + 1);
          await state.update(key, (current) => z.number().parse(current) + 1);
          // `undefined` commits nothing.
          await state.update(key, () => undefined);
          seen.push(state.entries('counter/'));
          return { value: state.read(key) };
        },
        identity: 'tool-state-fixture-1',
        inputSchema: Input,
        risk: 'read',
      },
    },
  };
}

async function finishedRun(client: HostClient, threadId: string): Promise<HostLogRow[]> {
  const { runId } = await client.request('run/start', {
    commandId: randomUUID(),
    modelId: 'scripted',
    prompt: 'Count',
    threadId,
  });
  let rows: HostLogRow[] = [];
  await expect
    .poll(async () => {
      rows = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
      return rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId);
    })
    .toBe(true);
  return rows;
}

test('tool state is the latest committed value per key, survives restart, and stays in its thread', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-tool-state-')));
  const seen: unknown[] = [];
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform(seen));
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    const { threadId: neighbor } = await client.request('thread/start', {
      commandId: randomUUID(),
    });
    const first = await finishedRun(client, threadId);
    expect(
      first.flatMap((row) =>
        row.event.type === 'tool.state.updated' ? [[row.event.key, row.event.value]] : []
      )
    ).toEqual([
      ['counter/a', 1],
      ['counter/a', 2],
      ['counter/b', 1],
      ['counter/b', 2],
    ]);
    expect(seen).toEqual([
      [['counter/a', 2]],
      [
        ['counter/a', 2],
        ['counter/b', 2],
      ],
    ]);

    await client.close();
    await host.close();
    host = await startAgentHost({ lifetime: 'persistent', root }, platform(seen));
    client = await attachAgentHost(host.record);
    seen.length = 0;
    await finishedRun(client, threadId);
    // The second run continues from the folded log after restart.
    expect(seen).toEqual([
      [
        ['counter/a', 4],
        ['counter/b', 2],
      ],
      [
        ['counter/a', 4],
        ['counter/b', 4],
      ],
    ]);
    seen.length = 0;
    await finishedRun(client, neighbor);
    // Another thread never sees this thread's keys.
    expect(seen[0]).toEqual([['counter/a', 2]]);
  } finally {
    await client?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  }
});
