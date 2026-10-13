import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_RESULT_SCHEMAS,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import { DEFAULT_THREAD_TITLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { afterEach, expect, test, vi } from 'vitest';
import { createWindowThreadCapability } from '../renderer/desktop-host-thread-capability';
// Original thread creation rows from the ordinary app-owned SQLite GUI receipt.
import recording from './fixtures/committed-app-owned-host-thread.json';

const connect = vi.hoisted(() => vi.fn<() => Promise<HostClient>>());
vi.mock('../renderer/agent-host-client', () => ({ connectDesktopAgentHost: connect }));

const startedRows = recording.map((row) => HostLogRowSchema.parse(row));
const thread = startedRows[0]?.threadId;
const startedAt = startedRows.findLast((row) => row.event.type === 'thread.started')?.ts;
if (!(thread && startedAt !== undefined)) {
  throw new Error('The recorded host thread needs its committed creation rows');
}
const BINDING = {
  forgePrWatch: false,
  operatingRootDisplayName: 'repo',
  operatingRootId: 'root-repo',
  operatingRootPath: '/ws/repo',
  secondaryRootIds: ['root-other'],
};

/** A `thread/list` entry as Core serves it: the store's times and the committed binding. */
function catalogEntry(
  threadId: string,
  binding: Record<string, unknown> | null = null,
  updatedAt = startedAt
) {
  return { binding, createdAt: startedAt, threadId, updatedAt };
}
/** Core's ledger of no costed thread. */
const NO_COSTS = { threads: [] };

function fixture() {
  const request = vi.fn<(method: HostMethod, params: HostParams<HostMethod>) => Promise<unknown>>();
  const client: HostClient = {
    close: vi.fn(async () => undefined),
    // A live client: its transport stays open until the test or the frame closes it.
    closed: new Promise<void>(() => undefined),
    onChildrenChanged: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
    onMcpPresentation: vi.fn(() => () => undefined),
    onMcpSettings: vi.fn(() => () => undefined),
    onTelemetry: vi.fn(() => () => undefined),
    record: {
      endpoint: '/tmp/recorded-host-fixture',
      hostVersion: '0.1.0',
      pid: process.pid,
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      start: 'synthetic client fixture',
      token: 'a'.repeat(64),
    },
    request: async <Method extends HostMethod>(
      method: Method,
      params: HostParams<Method>
    ): Promise<HostResults[Method]> =>
      HOST_RESULT_SCHEMAS[method].parse(await request(method, params)) as HostResults[Method],
  };
  connect.mockResolvedValue(client);
  return {
    capability: createWindowThreadCapability(({ owned, threadId }) =>
      owned ? threadId : undefined
    ),
    request,
  };
}

afterEach(async () => {
  window.dispatchEvent(new Event('beforeunload'));
  await Promise.resolve();
  vi.clearAllMocks();
});

test('a host thread commits its workspace binding keys through the host, exactly once', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(thread)] })
    .mockResolvedValueOnce(NO_COSTS)
    .mockResolvedValueOnce({ accepted: true });
  expect(await capability.ownsThread(thread)).toBe(true);
  await capability.updateThreadBinding(thread, BINDING);
  const updates = request.mock.calls.filter(
    ([method]) => method === 'thread/workspace/binding/update'
  );
  expect(updates).toHaveLength(1);
  expect(updates[0]?.[1]).toMatchObject({ patch: BINDING, threadId: thread });
});

test('a key the host does not own is refused visibly before any request', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(thread)] })
    .mockResolvedValueOnce(NO_COSTS);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  const calls = request.mock.calls.length;
  await expect(
    capability.updateThreadBinding(thread, { color: 'emerald', forgePrWatch: true, model: 'gpt-5' })
  ).rejects.toThrow(/\bmodel\b/u);
  await expect(
    capability.updateThreadBinding(thread, { operatingRootId: 'root-repo' })
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(calls);
});

test('a thread outside the host catalog is not host-owned', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(thread)] })
    .mockResolvedValueOnce(NO_COSTS)
    // After the snapshot, each miss is re-resolved against the host's catalog.
    .mockResolvedValueOnce({ threads: [catalogEntry(thread)] });
  expect(await capability.ownsThread('legacy-history-thread')).toBe(false);
  await expect(capability.updateThreadBinding('legacy-history-thread', BINDING)).rejects.toThrow();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'thread/list',
    'ledger/read',
    'thread/list',
  ]);
});

test('a failed owner read rejects instead of classifying the thread as historical', async () => {
  const { capability, request } = fixture();
  const unreachable = new Error('The agent host connection closed');
  request
    .mockResolvedValueOnce({ threads: [] })
    .mockResolvedValueOnce(NO_COSTS)
    .mockRejectedValueOnce(unreachable);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  await expect(capability.ownsThread(thread)).rejects.toBe(unreachable);
});

test('a thread created after the catalog loaded is host-owned without another catalog read', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [] })
    .mockResolvedValueOnce(NO_COSTS)
    .mockResolvedValueOnce({ threadId: thread })
    .mockResolvedValueOnce({ rows: startedRows });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(await capability.createThread(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual({
    createdAt: new Date(startedAt),
    id: thread,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: DEFAULT_THREAD_TITLE,
    updatedAt: new Date(startedAt),
  });
  expect(await capability.ownsThread(thread)).toBe(true);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'thread/list',
    'ledger/read',
    'thread/start',
    'thread/read',
  ]);
});

test('the thread list is the catalog and one ledger read, never a thread log', async () => {
  const { capability, request } = fixture();
  request.mockImplementation(async (method) => {
    if (method === 'thread/list') {
      return { threads: [catalogEntry(thread), catalogEntry('second-thread')] };
    }
    if (method === 'ledger/read') {
      return NO_COSTS;
    }
    throw new Error(`The thread list read ${method}`);
  });
  expect(await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toHaveLength(2);
  expect(request.mock.calls.map(([method]) => method).sort()).toEqual([
    'ledger/read',
    'thread/list',
  ]);
});

test("the catalog entry's binding, colour and times are the thread's metadata and dates", async () => {
  const { capability, request } = fixture();
  const updatedAt = startedAt + 60_000;
  request
    .mockResolvedValueOnce({
      threads: [{ ...catalogEntry(thread, BINDING, updatedAt), color: 'emerald' }],
    })
    .mockResolvedValueOnce(NO_COSTS);
  const [projected] = await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(projected).toMatchObject({
    createdAt: new Date(startedAt),
    metadata: { ...BINDING, color: 'emerald' },
    updatedAt: new Date(updatedAt),
  });
});

test('an unbound host thread projects no metadata', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [catalogEntry(thread)] })
    .mockResolvedValueOnce(NO_COSTS);
  const [projected] = await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(projected && 'metadata' in projected).toBe(false);
});

test('a damaged thread stays listed with its catalog dates and its read failure', async () => {
  const { capability, request } = fixture();
  const damage = 'missing seq 7';
  request
    .mockResolvedValueOnce({ threads: [{ ...catalogEntry(thread), damage }] })
    .mockResolvedValueOnce(NO_COSTS);
  expect(await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID)).toEqual([
    {
      createdAt: new Date(startedAt),
      id: thread,
      readFailure: damage,
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: DEFAULT_THREAD_TITLE,
      updatedAt: new Date(startedAt),
    },
  ]);
});
