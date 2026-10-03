import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import { afterEach, expect, it, vi } from 'vitest';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { registerIndexSearchIpcHandlers } from '../ipc-index-search';
import { createIpcBridge } from '../platform/ipc-bridge';
import { createTrustedInvokeEvent } from './helpers/desktop-ipc-sender-test-helpers';

const ipc = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: ipc }));
const dispose: Array<() => void> = [];
afterEach(() => {
  for (const fn of dispose.splice(0)) {
    fn();
  }
  vi.clearAllMocks();
});
function handler(name: keyof typeof indexSearchContract) {
  const entry = ipc.handle.mock.calls.find(
    ([channel]) => channel === indexSearchContract[name].channel
  );
  if (!entry) {
    throw new Error('Expected registered native index channel.');
  }
  return entry[1];
}
function capability(): IndexSearchCapability {
  return {
    coverage: vi.fn(async () => {
      throw new Error('Coverage failure');
    }),
    grep: vi.fn(async () => {
      throw new Error('Grep failure');
    }),
    search: vi.fn(async () => {
      throw new Error('Search failure');
    }),
    status: vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'No configured index owner.',
    })),
  };
}
it('uses the visible-ui authorized manifest and canonical preload result/error unwrap', async () => {
  const cap = capability();
  dispose.push(registerIndexSearchIpcHandlers(cap));
  const bridge = createIpcBridge(
    {
      invoke: async (channel, ...args) => {
        const entry = ipc.handle.mock.calls.find(([name]) => name === channel);
        if (!entry) {
          throw new Error('Unknown channel');
        }
        return entry[1](createTrustedInvokeEvent(), ...args);
      },
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    indexSearchContract
  );
  await expect(bridge.status()).resolves.toEqual({
    kind: 'unavailable',
    reason: 'No configured index owner.',
  });
  await expect(bridge.coverage({ rootIds: ['r'] })).rejects.toThrow('Coverage failure');
});
it('rejects hidden, untracked and foreign-frame senders before payload parsing or capability calls', async () => {
  const cap = capability();
  dispose.push(registerIndexSearchIpcHandlers(cap));
  const invoke = handler('coverage');
  await expect(invoke(createTrustedInvokeEvent('embedding-host'), null)).rejects.toThrow();
  await expect(
    invoke(
      { sender: { id: 78_123_456 }, senderFrame: createTrustedInvokeEvent().senderFrame },
      null
    )
  ).rejects.toThrow();
  await expect(
    invoke(
      { ...createTrustedInvokeEvent(), senderFrame: { url: 'https://foreign.example/' } },
      null
    )
  ).rejects.toThrow();
  expect(cap.coverage).not.toHaveBeenCalled();
  await expect(invoke(createTrustedInvokeEvent(), { rootIds: ['r', 'r'] })).rejects.toThrow(
    'unique'
  );
});
it('preserves explicit grep options and refuses incomplete or mixed vector profiles', () => {
  const request = {
    caseSensitive: true,
    isRegex: true,
    limit: 100,
    pattern: '\\bword\\b',
    rootIds: ['r'],
  };
  expect(indexSearchContract.grep.parseArgs([request])).toEqual([request]);
  expect(() =>
    indexSearchContract.search.parseArgs([
      { limit: 10, mode: 'vector', profile: {}, rootIds: ['r'], vector: [] },
    ])
  ).toThrow();
  expect(() =>
    indexSearchContract.search.parseArgs([
      { limit: 10, mode: 'bm25', rootIds: ['r'], text: 'x', vector: [] },
    ])
  ).toThrow();
});
