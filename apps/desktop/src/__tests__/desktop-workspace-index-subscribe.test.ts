// @vitest-environment node
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import type { NativeIndexObservation } from '@brainstrike/indexing-contract/indexer-client';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createDesktopWorkspaceIndex } from '../agent-host-platform/desktop-workspace-index';

/** The index's lifecycle push and its saved settings, as the test drives them. */
const harness = vi.hoisted(() => ({
  publishConfig: undefined as ((config: IndexConfig) => void) | undefined,
  publishObservation: undefined as ((observation: NativeIndexObservation) => void) | undefined,
  read: undefined as (() => Promise<IndexConfig>) | undefined,
}));
vi.mock('../native-index-activation', () => ({
  createNativeIndexActivation: () => ({
    acquire: async () => undefined,
    close: async () => undefined,
    fenceTerminal: () => undefined,
  }),
}));
vi.mock('../native-index-observations', () => ({
  observeNativeIndex: async (dependencies: {
    readonly publish: (observation: NativeIndexObservation) => void;
  }) => {
    harness.publishObservation = dependencies.publish;
  },
}));
vi.mock('../index-config', async (original) => ({
  ...(await original<typeof import('../index-config')>()),
  createDesktopIndexConfig: (dependencies: { readonly publish: (config: IndexConfig) => void }) => {
    harness.publishConfig = dependencies.publish;
    return { read: () => harness.read?.() };
  },
}));

const READY: NativeIndexObservation = {
  lifecycle: { generation: 2, kind: 'ready' },
  progress: { kind: 'failed', reason: 'The replacement index has not scanned yet.' },
};

function openIndex(read: () => Promise<IndexConfig>) {
  harness.read = read;
  const workspaceIndex = createDesktopWorkspaceIndex({
    databasePath: '/unused/index.sqlite',
    embedding: {},
    folders: { roots: { reserveRootDataDeletion: vi.fn() } },
    forkLentUtility: vi.fn(),
    hostedCredentials: {},
    isClosing: () => false,
    lifecycleDelays: {},
    signal: new AbortController().signal,
    store: {},
  } as unknown as Parameters<typeof createDesktopWorkspaceIndex>[0]);
  onTestFinished(() => workspaceIndex.close());
  return workspaceIndex;
}

it('a window that subscribes after the index settled starts from its current settings and lifecycle', async () => {
  // A window that outlived its host subscribes to the replacement, whose index already settled.
  const workspaceIndex = openIndex(async () => DEFAULT_INDEX_CONFIG);
  harness.publishObservation?.(READY);
  const events = vi.fn();
  workspaceIndex.index.subscribe(events);
  await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(2));
  expect(events.mock.calls).toEqual([
    [{ observation: READY, type: 'lifecycle' }],
    [{ config: DEFAULT_INDEX_CONFIG, type: 'config' }],
  ]);
});

it('a settings change saved while a new subscriber reads the settings is the last one it sees', async () => {
  const read = Promise.withResolvers<IndexConfig>();
  const workspaceIndex = openIndex(() => read.promise);
  const events = vi.fn();
  workspaceIndex.index.subscribe(events);
  const paused: IndexConfig = { ...DEFAULT_INDEX_CONFIG, paused: true };
  harness.publishConfig?.(paused);
  read.resolve(DEFAULT_INDEX_CONFIG);
  await Promise.resolve();
  await Promise.resolve();
  expect(events.mock.calls).toEqual([[{ config: paused, type: 'config' }]]);
});
