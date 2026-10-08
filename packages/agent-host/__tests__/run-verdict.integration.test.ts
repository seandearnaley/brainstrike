import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import recording from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import { projectRunVerdicts } from '../dist/run-verdicts.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import { storedHostEvent } from '../src/event-storage.js';
import { HostLogRowSchema } from '../src/protocol.js';

test('run/verdict commits one user verdict per command for a committed run and survives reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-run-verdict-')));
  const start = (): Promise<AgentHost> =>
    startAgentHost(
      { lifetime: 'persistent', root },
      {
        close: async () => undefined,
        readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      }
    );
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    const captured = z.array(HostLogRowSchema).parse(recording);
    const threadId = captured[0]?.threadId;
    const started = captured.find((row) => row.event.type === 'run.started');
    if (!(threadId && started && started.event.type === 'run.started')) {
      throw new Error('The recorded Core run is required');
    }
    const runId = started.event.runId;
    const seed = await StateStore.open(root);
    try {
      await seed.append(captured.map((row) => storedHostEvent(row.threadId, row.event)));
    } finally {
      await seed.close();
    }
    host = await start();
    client = await attachAgentHost(host.record);

    const failed = {
      commandId: randomUUID(),
      runId,
      source: 'user' as const,
      threadId,
      verdict: 'failed' as const,
    };
    expect(await client.request('run/verdict', failed)).toEqual({ accepted: true });
    const once = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(await client.request('run/verdict', failed)).toEqual({ accepted: true });
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(once);
    expect(once.at(-1)?.event).toEqual({
      runId,
      source: 'user',
      type: 'run.verdict',
      verdict: 'failed',
    });

    // A later user verdict replaces the earlier one.
    await client.request('run/verdict', { ...failed, commandId: randomUUID(), verdict: 'mixed' });
    await expect(
      client.request('run/verdict', { ...failed, commandId: randomUUID(), runId: 'unknown-run' })
    ).rejects.toThrow('Unknown run');

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    host = await start();
    client = await attachAgentHost(host.record);
    const reopened = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(projectRunVerdicts(reopened).get(runId)).toMatchObject({
      source: 'user',
      verdict: 'mixed',
    });
  } finally {
    await client?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  }
});
