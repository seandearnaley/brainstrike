import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../dist/client.js';
import { createProductionHostPlatform } from '../dist/production-platform.js';
import { type AgentHost, startAgentHost } from '../dist/runtime.js';

// The production composition shared by the desktop and standalone hosts; no
// test-supplied indexer, so thread deletion uses whatever that composition owns.
function startProductionHost(root: string): Promise<AgentHost> {
  return startAgentHost({ lifetime: 'persistent', root }, (startup) =>
    createProductionHostPlatform({
      close: async () => undefined,
      readConfiguration: async () => {
        throw new Error('Thread deletion must not admit a run');
      },
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
      resolveProviderAuth: async () => {
        throw new Error('Thread deletion must not resolve provider auth');
      },
      startup,
    })
  );
}

test('the production host composition deletes a committed thread and it stays deleted across reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-production-thread-delete-')));
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startProductionHost(root);
    client = await attachAgentHost(host.record);
    const { threadId: target } = await client.request('thread/start', { commandId: randomUUID() });
    const { threadId: neighbor } = await client.request('thread/start', {
      commandId: randomUUID(),
    });
    const before = await client.request('thread/read', { fromSeq: 0, threadId: neighbor });

    expect(await client.request('thread/delete', { threadId: target })).toEqual({ deleted: true });
    const listed = (await client.request('thread/list', {})).threads.map(
      (thread) => thread.threadId
    );
    expect(listed).toContain(neighbor);
    expect(listed).not.toContain(target);

    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    host = await startProductionHost(root);
    client = await attachAgentHost(host.record);
    const reopened = (await client.request('thread/list', {})).threads.map(
      (thread) => thread.threadId
    );
    expect(reopened).toContain(neighbor);
    expect(reopened).not.toContain(target);
    expect(await client.request('thread/read', { fromSeq: 0, threadId: neighbor })).toEqual(before);
  } finally {
    await client?.close();
    await host?.close();
    await rm(root, { force: true, recursive: true });
  }
});
