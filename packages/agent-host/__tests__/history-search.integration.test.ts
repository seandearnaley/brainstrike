import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import { createProductionHostPlatform } from '../dist/production-platform.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';
import { storedHostEvent } from '../src/event-storage.js';
import { HostLogRowSchema } from '../src/protocol.js';

function startProductionHost(root: string): Promise<AgentHost> {
  return startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      readConfiguration: async () => {
        throw new Error('History search must not admit a run');
      },
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveProviderAuth: async () => {
        throw new Error('History search must not resolve provider auth');
      },
      startup,
    })
  );
}

test('history/search finds committed text across host threads and forgets a deleted thread', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-history-search-')));
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    // Two recorded Core threads with distinct committed prompts.
    const tool = z.array(HostLogRowSchema).parse(approved);
    const runs = z.array(HostLogRowSchema).parse(rich);
    const toolThread = tool[0]?.threadId;
    const runsThread = runs[0]?.threadId;
    const toolStarted = tool.find((row) => row.event.type === 'run.started');
    const runStarts = runs.filter((row) => row.event.type === 'run.started').map((row) => row.seq);
    if (!(toolThread && runsThread && toolStarted) || runStarts.length !== 2) {
      throw new Error('The recorded Core runs are required');
    }
    const seed = await StateStore.open(root);
    try {
      await seed.append([...tool, ...runs].map((row) => storedHostEvent(row.threadId, row.event)));
    } finally {
      await seed.close();
    }
    host = await startProductionHost(root);
    client = await attachAgentHost(host.record);
    const { threadId: empty } = await client.request('thread/start', { commandId: randomUUID() });

    const byTool = await client.request('history/search', { limit: 20, query: 'fixture tool' });
    const committedAt = (
      await client.request('thread/read', { fromSeq: 0, threadId: toolThread })
    ).rows.find((row) => row.seq === toolStarted.seq)?.ts;
    expect(committedAt).toEqual(expect.any(Number));
    expect(byTool.hits).toContainEqual({
      seq: toolStarted.seq,
      snippet: expect.stringContaining('fixture tool'),
      threadId: toolThread,
      ts: committedAt,
    });
    expect(new Set(byTool.hits.map((hit) => hit.threadId))).toEqual(new Set([toolThread]));

    const byRun = await client.request('history/search', { limit: 20, query: 'committed run' });
    expect(byRun.hits).toEqual(
      expect.arrayContaining(
        runStarts.map((seq) => ({
          seq,
          snippet: expect.stringContaining('committed run'),
          threadId: runsThread,
          ts: expect.any(Number),
        }))
      )
    );
    expect(byRun.hits.map((hit) => hit.threadId)).not.toContain(empty);

    await client.request('thread/delete', { threadId: runsThread });
    expect(
      (await client.request('history/search', { limit: 20, query: 'committed run' })).hits
    ).toEqual([]);
    expect(
      (await client.request('history/search', { limit: 20, query: 'fixture tool' })).hits
    ).toEqual(byTool.hits);
  } finally {
    await client?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  }
});
