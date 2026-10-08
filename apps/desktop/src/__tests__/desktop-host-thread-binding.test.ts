import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_RESULT_SCHEMAS,
  type HostLogRow,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
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

/** The two rows Core commits for one accepted binding update (workspace-state.ts). */
function boundRows(
  seq: number,
  ts: number,
  binding: Record<string, unknown> = BINDING,
  commandId = '0f3b9a3e-1d2c-4f5e-8a7b-6c5d4e3f2a10'
): HostLogRow[] {
  return [
    HostLogRowSchema.parse({
      event: {
        commandId,
        method: 'thread/workspace/binding/update',
        payload: { commandId, patch: binding, threadId: thread },
        result: { accepted: true },
        type: 'command.accepted',
      },
      seq,
      threadId: thread,
      ts,
    }),
    HostLogRowSchema.parse({
      event: { binding, type: 'workspace.binding.updated' },
      seq: seq + 1,
      threadId: thread,
      ts,
    }),
  ];
}

function fixture() {
  const request = vi.fn<(method: HostMethod, params: HostParams<HostMethod>) => Promise<unknown>>();
  const client: HostClient = {
    close: vi.fn(async () => undefined),
    closed: Promise.resolve(),
    onEvent: vi.fn(() => () => undefined),
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
    capability: createWindowThreadCapability((host, threadId) => (host ? threadId : undefined)),
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
    .mockResolvedValueOnce({ threads: [{ threadId: thread }] })
    .mockResolvedValueOnce({ rows: startedRows })
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
    .mockResolvedValueOnce({ threads: [{ threadId: thread }] })
    .mockResolvedValueOnce({ rows: startedRows });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  const calls = request.mock.calls.length;
  await expect(
    capability.updateThreadBinding(thread, { color: 'emerald', forgePrWatch: true })
  ).rejects.toThrow(/\bcolor\b/u);
  await expect(
    capability.updateThreadBinding(thread, { operatingRootId: 'root-repo' })
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(calls);
});

test('a thread outside the host catalog is not host-owned', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [{ threadId: thread }] })
    .mockResolvedValueOnce({ rows: startedRows })
    // After the snapshot, each miss is re-resolved against the host's catalog.
    .mockResolvedValueOnce({ threads: [{ threadId: thread }] });
  expect(await capability.ownsThread('legacy-history-thread')).toBe(false);
  await expect(capability.updateThreadBinding('legacy-history-thread', BINDING)).rejects.toThrow();
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'thread/list',
    'thread/read',
    'thread/list',
  ]);
});

test('a failed owner read rejects instead of classifying the thread as historical', async () => {
  const { capability, request } = fixture();
  const unreachable = new Error('The agent host connection closed');
  request.mockResolvedValueOnce({ threads: [] }).mockRejectedValueOnce(unreachable);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  await expect(capability.ownsThread(thread)).rejects.toBe(unreachable);
});

test('a thread created after the catalog loaded is host-owned without another catalog read', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [] })
    .mockResolvedValueOnce({ threadId: thread })
    .mockResolvedValueOnce({ rows: startedRows });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  await capability.createThread(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(await capability.ownsThread(thread)).toBe(true);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'thread/list',
    'thread/start',
    'thread/read',
  ]);
});

test('the catalog projects the latest committed binding; binding rows never move updatedAt', async () => {
  const { capability, request } = fixture();
  const boundAt = startedAt + 60_000;
  request.mockResolvedValueOnce({ threads: [{ threadId: thread }] }).mockResolvedValueOnce({
    rows: [...startedRows, ...boundRows(startedRows.length + 1, boundAt)],
  });
  const [projected] = await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(projected?.metadata).toEqual(BINDING);
  expect(projected?.updatedAt).toEqual(new Date(startedAt));
});

test('a later committed binding replaces the earlier one in the projection', async () => {
  const { capability, request } = fixture();
  const { secondaryRootIds: _secondaryRootIds, ...earlier } = BINDING;
  const later = { ...BINDING, forgePrWatch: true };
  const next = startedRows.length + 1;
  request.mockResolvedValueOnce({ threads: [{ threadId: thread }] }).mockResolvedValueOnce({
    rows: [
      ...startedRows,
      ...boundRows(next, startedAt + 1000, earlier),
      ...boundRows(next + 2, startedAt + 2000, later, '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d'),
    ],
  });
  const [projected] = await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(projected?.metadata).toEqual(later);
});

test('an unbound host thread projects no metadata', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [{ threadId: thread }] })
    .mockResolvedValueOnce({ rows: startedRows });
  const [projected] = await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(projected && 'metadata' in projected).toBe(false);
});
