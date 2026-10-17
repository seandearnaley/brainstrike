import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpTaskStorage } from '@brainstrike/assistant-contract/mcp-task-store';
import { stateStoreMcpTaskStorage } from '@brainstrike/host-capabilities/mcp/state-store-task-storage';
import { StateStore } from '@brainstrike/state-store';

/** The conformance client's own MCP Tasks store: a StateStore in a temporary root. */
export interface EphemeralConformanceTaskStore {
  /** Closes the store, if one opened, and removes its root. */
  close(): Promise<void>;
  open(): Promise<McpTaskStorage>;
}

interface OpenedRoot {
  readonly root: string;
  readonly store: StateStore;
}

async function openRoot(): Promise<OpenedRoot> {
  const root = await mkdtemp(path.join(tmpdir(), 'brainstrike-mcp-conformance-'));
  try {
    return { root, store: await StateStore.open(root) };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

/** Opened on the first Tasks-advertising connection, like the host's StateStore task storage. */
export function createEphemeralConformanceTaskStore(): EphemeralConformanceTaskStore {
  let opening: Promise<OpenedRoot> | undefined;
  return {
    async close() {
      if (opening === undefined) {
        return;
      }
      const [settled] = await Promise.allSettled([opening]);
      // A failed open already rejected its caller and removed its root.
      if (settled.status === 'rejected') {
        return;
      }
      const { root, store } = settled.value;
      try {
        await store.close();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    async open() {
      opening ??= openRoot();
      return stateStoreMcpTaskStorage((await opening).store);
    },
  };
}
