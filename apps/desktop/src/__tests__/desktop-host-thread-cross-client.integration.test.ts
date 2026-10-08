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
