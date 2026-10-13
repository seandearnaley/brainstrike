// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentHost, startAgentHost } from '@brainstrike/agent-host';
import { attachAgentHost, type HostClient } from '@brainstrike/agent-host/client';
import { withAssistantThreadHost } from '@brainstrike/app-shell/assistant-thread-host-context';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import {
  type AssistantThreadRepository,
  EMPTY_WORKSPACE_SNAPSHOT,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { createWindowThreadCapability } from '../renderer/desktop-host-thread-capability';

const connect = vi.hoisted(() => vi.fn<() => Promise<HostClient>>());
vi.mock('../renderer/agent-host-client', () => ({ connectDesktopAgentHost: connect }));

let host: AgentHost | undefined;
let other: HostClient | undefined;
let root: string | undefined;
const frame = new EventTarget();

afterEach(async () => {
  // The capability owns the window's client and joins it on beforeunload.
  frame.dispatchEvent(new Event('beforeunload'));
  await other?.close();
  other = undefined;
  await host?.close();
  host = undefined;
  if (root && RootLock.inspect(root)?.owner.released) {
    await rm(root, { recursive: true });
  }
  root = undefined;
  vi.unstubAllGlobals();
});

test('a host thread another client created after the catalog snapshot keeps its host owner', async () => {
  vi.stubGlobal('window', frame);
  root = await mkdtemp(join(tmpdir(), 'bs-m3-cross-client-binding-'));
  host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    }
  );
  const windowClient = await attachAgentHost(host.record);
  connect.mockResolvedValue(windowClient);
  const capability = createWindowThreadCapability(() => undefined);
  const updateHistory = vi.fn<AssistantThreadRepository['updateThreadMetadata']>();
  const repository = withAssistantThreadHost(
    { updateThreadMetadata: updateHistory } as unknown as AssistantThreadRepository,
    capability
  );

  // This window takes its catalog snapshot first...
  expect(await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([]);
  // ...then a second client (another window or the CLI) creates a host thread.
  other = await attachAgentHost(host.record);
  const { threadId } = await other.request('thread/start', { commandId: randomUUID() });

  expect(await capability.ownsThread(threadId)).toBe(true);
  await repository.updateThreadMetadata(threadId, { forgePrWatch: false });
  expect(updateHistory).not.toHaveBeenCalled();
  expect(await other.request('thread/workspace/binding/read', { threadId })).toEqual({
    binding: { forgePrWatch: false },
  });
});

test('an id the host has never heard of is historical only after the host says so', async () => {
  vi.stubGlobal('window', frame);
  root = await mkdtemp(join(tmpdir(), 'bs-m3-cross-client-binding-'));
  host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    }
  );
  connect.mockResolvedValue(await attachAgentHost(host.record));
  const capability = createWindowThreadCapability(() => undefined);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(await capability.ownsThread('historical-pglite-thread')).toBe(false);
});

test('a host thread keeps its title, colour and icon across a reload, a second client and a host restart', async () => {
  vi.stubGlobal('window', frame);
  root = await mkdtemp(join(tmpdir(), 'bs-m3-cross-client-rename-'));
  const platform = {
    close: async () => undefined,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
  };
  host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  connect.mockResolvedValueOnce(await attachAgentHost(host.record));
  const capability = createWindowThreadCapability(() => undefined);
  const renameHistory = vi.fn<AssistantThreadRepository['renameThread']>();
  const updateHistory = vi.fn<AssistantThreadRepository['updateThreadMetadata']>();
  const repository = withAssistantThreadHost(
    {
      renameThread: renameHistory,
      updateThreadMetadata: updateHistory,
    } as unknown as AssistantThreadRepository,
    capability
  );
  const created = await capability.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
  await repository.renameThread(created.id, 'Release plan');
  await repository.updateThreadMetadata(created.id, { color: 'emerald', icon: 'rocket' });
  expect(renameHistory).not.toHaveBeenCalled();
  expect(updateHistory).not.toHaveBeenCalled();
  const presented = expect.objectContaining({
    id: created.id,
    metadata: { color: 'emerald', icon: 'rocket' },
    title: 'Release plan',
  });

  // A reload: this window's client closes and a fresh window lists the catalog.
  frame.dispatchEvent(new Event('beforeunload'));
  connect.mockResolvedValueOnce(await attachAgentHost(host.record));
  const reloaded = createWindowThreadCapability(() => undefined);
  expect(await reloaded.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([presented]);

  // A second client (another window or the CLI) sees the committed title.
  other = await attachAgentHost(host.record);
  expect((await other.request('thread/list', {})).threads).toEqual([
    {
      binding: null,
      color: 'emerald',
      createdAt: created.createdAt.getTime(),
      icon: 'rocket',
      threadId: created.id,
      title: 'Release plan',
      updatedAt: expect.any(Number),
    },
  ]);

  // A host restart folds the same title from the log.
  frame.dispatchEvent(new Event('beforeunload'));
  await other.close();
  other = undefined;
  await host.close();
  host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  connect.mockResolvedValueOnce(await attachAgentHost(host.record));
  const restarted = createWindowThreadCapability(() => undefined);
  expect(await restarted.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([presented]);
});

test('host workspace snapshots remain available without a history database and reject unowned writes', async () => {
  vi.stubGlobal('window', frame);
  root = await mkdtemp(join(tmpdir(), 'bs-native-workspace-snapshot-'));
  host = await startAgentHost(
    { lifetime: 'persistent', root },
    {
      close: async () => undefined,
      readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    }
  );
  connect.mockResolvedValue(await attachAgentHost(host.record));
  const capability = createWindowThreadCapability(() => undefined);
  const thread = await capability.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
  const repository = capability.workspaceRepository();
  const snapshot = {
    ...EMPTY_WORKSPACE_SNAPSHOT,
    roots: { focusedRootId: 'root-a', visibleRootIds: ['root-a'] },
  };
  await repository.setThreadWorkspace(thread.id, WORKSPACE_MEMORY_RESOURCE_ID, snapshot);
  other = await attachAgentHost(host.record);
  expect((await other.request('thread/workspace/read', { threadId: thread.id })).snapshot).toEqual(
    snapshot
  );
  expect(await repository.getThreadWorkspace(thread.id)).toEqual(snapshot);
  expect(await repository.getThreadWorkspaces([thread.id])).toEqual(
    new Map([[thread.id, snapshot]])
  );
  await expect(
    repository.setThreadWorkspace('unknown-thread', WORKSPACE_MEMORY_RESOURCE_ID, snapshot)
  ).rejects.toThrow('not owned');
});
