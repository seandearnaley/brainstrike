import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  HOST_RESULT_SCHEMAS,
  HostLogRowSchema,
  type HostMethod,
  type HostParams,
  type HostResults,
} from '@brainstrike/agent-host/protocol';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import questionRecording from '@brainstrike/test-utils/fixtures/committed-host-question.json';
import { afterEach, expect, test, vi } from 'vitest';
import { createWindowThreadCapability } from '../renderer/desktop-host-thread-capability';
// Original thread creation rows from the ordinary app-owned SQLite GUI receipt.
import richRecording from './fixtures/committed-app-owned-host-thread.json';

const connect = vi.hoisted(() => vi.fn<() => Promise<HostClient>>());
vi.mock('../renderer/agent-host-client', () => ({ connectDesktopAgentHost: connect }));

const richRows = richRecording.map((row) => HostLogRowSchema.parse(row));
const questionRows = questionRecording.map((row) => HostLogRowSchema.parse(row));
const firstThread = richRows[0]?.threadId;
const laterThread = questionRows[0]?.threadId;
if (!(firstThread && laterThread && firstThread !== laterThread)) {
  throw new Error('Recorded independent Core threads are required');
}

function fixture() {
  const request = vi.fn<(method: HostMethod, params: HostParams<HostMethod>) => Promise<unknown>>();
  const client: HostClient = {
    close: vi.fn(async () => undefined),
    closed: Promise.resolve(),
    onChildrenChanged: vi.fn(() => () => undefined),
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
    capability: createWindowThreadCapability(({ host, threadId }) => (host ? threadId : undefined)),
    request,
  };
}

afterEach(async () => {
  window.dispatchEvent(new Event('beforeunload'));
  await Promise.resolve();
  vi.clearAllMocks();
});

test('deletion recognizes a Core thread committed after the visible catalog was hydrated', async () => {
  const { capability, request } = fixture();
  request
    .mockResolvedValueOnce({ threads: [{ threadId: firstThread }] })
    .mockResolvedValueOnce({ rows: richRows })
    .mockResolvedValueOnce({ threads: [{ threadId: firstThread }, { threadId: laterThread }] })
    .mockResolvedValueOnce({ deleted: true });
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(await capability.deleteThread(laterThread)).toBe(true);
  expect(request).toHaveBeenLastCalledWith('thread/delete', { threadId: laterThread });
});

test('a failed Core-owned deletion retains the visible owner and rejects', async () => {
  const { capability, request } = fixture();
  const failure = new Error('The native deletion owner did not join');
  request
    .mockResolvedValueOnce({ threads: [{ threadId: firstThread }] })
    .mockResolvedValueOnce({ rows: richRows })
    .mockResolvedValueOnce({ threads: [{ threadId: firstThread }] })
    .mockRejectedValueOnce(failure);
  await capability.listThreads(WORKSPACE_MEMORY_RESOURCE_ID);
  await expect(capability.deleteThread(firstThread)).rejects.toBe(failure);
  expect(capability.renderThread(firstThread, true)).toBeDefined();
});
