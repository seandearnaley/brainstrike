import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { RootLock } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { attachAgentHost, type HostClient } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { HOST_RESULT_SCHEMAS } from '../src/protocol.js';
import { type AgentHost, startAgentHost } from '../src/runtime.js';

// Actual ordinary-renderer capture, 7 October 00:55 UTC, evidence e43fc16e.
// The fixture retains the app's real workspace payload without profile data.
test('the committed ordinary workspace uses the root writer and survives host restart', async () => {
  const recorded: unknown = JSON.parse(
    await readFile(new URL('./fixtures/ordinary-workspace-snapshot.json', import.meta.url), 'utf8')
  );
  const snapshot = WorkspaceSnapshotSchema.parse(
    HOST_RESULT_SCHEMAS['thread/workspace/read'].parse(recorded).snapshot
  );
  const root = await mkdtemp(join(tmpdir(), 'bs-m3-workspace-'));
  const platform: HostPlatform = {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  };
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  try {
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    expect(await client.request('thread/workspace/read', { threadId })).toEqual({ snapshot: null });
    const published: unknown[] = [];
    const active = host;
    const release = host.core.onCommitted((row) => {
      if (row.event.type === 'workspace.updated') {
        published.push(active.core.readWorkspace(threadId).snapshot);
      }
    });
    const params = { commandId: randomUUID(), snapshot, threadId };
    await client.request('thread/workspace/set', params);
    const committed = (await client.request('thread/read', { fromSeq: 0, threadId })).rows;
    expect(published).toEqual([snapshot]);
    expect(committed.filter((row) => row.event.type === 'workspace.updated')).toHaveLength(1);
    expect(await client.request('thread/workspace/set', params)).toEqual({ accepted: true });
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(committed);
    const { threadId: other } = await client.request('thread/start', { commandId: randomUUID() });
    await expect(
      client.request('thread/workspace/set', { ...params, threadId: other })
    ).rejects.toThrow();
    const view = host.core.readWorkspace(threadId).snapshot;
    view?.apps.openAppIds.push('view-only');
    expect(await client.request('thread/workspace/read', { threadId })).toEqual({ snapshot });
    release();
    await client.close();
    client = undefined;
    await host.close();
    host = undefined;
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    host = await startAgentHost({ lifetime: 'persistent', root }, platform);
    client = await attachAgentHost(host.record);
    expect(await client.request('thread/workspace/read', { threadId })).toEqual({ snapshot });
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(committed);
    await client.request('thread/workspace/set', params);
    expect((await client.request('thread/read', { fromSeq: 0, threadId })).rows).toEqual(committed);
    await expect(
      client.request('thread/workspace/set', { ...params, threadId: other })
    ).rejects.toThrow();
  } finally {
    await client?.close();
    await host?.close();
    if (RootLock.inspect(root)?.owner.released) {
      await rm(root, { force: true, recursive: true });
    }
  }
});
