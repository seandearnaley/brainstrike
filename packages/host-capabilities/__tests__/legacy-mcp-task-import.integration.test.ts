// The desktop's PGlite Tasks rows move once into the host StateStore
// (BST-1930 ruling B): written by the legacy PGlite repository, read the way
// Main reads them, carried as JSON, imported by the host.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type McpTaskAuthorityLease,
  McpTaskRepository,
  McpTaskStore,
  migrate,
  readPgliteMcpTaskRows,
  wasmLoader,
} from '@brainstrike/db';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importLegacyMcpTasks } from '../src/mcp/legacy-task-import.js';
import { stateStoreMcpTaskStorage } from '../src/mcp/state-store-task-storage.js';

const scope = {
  principalId: 'linear:user-42',
  resource: 'https://mcp.linear.app/mcp',
  serverId: 'linear',
} as const;

function identity(authority: McpTaskAuthorityLease, taskId: string) {
  return {
    authorityEpoch: authority.authorityEpoch,
    principalId: authority.principalId,
    resource: authority.resource,
    serverId: authority.serverId,
    taskId,
  } as const;
}

describe('the one-time import of the desktop PGlite Tasks rows', () => {
  const roots: string[] = [];
  const stores: StateStore[] = [];
  let pg: Awaited<ReturnType<typeof wasmLoader.createPGlite>> | undefined;

  async function legacyDatabase(): Promise<McpTaskRepository> {
    pg = await wasmLoader.createPGlite('memory://legacy-mcp-tasks');
    await migrate(pg);
    return new McpTaskRepository(pg);
  }

  /** What Main hands over: its PGlite rows, carried as JSON. */
  async function mainRows(): Promise<unknown> {
    if (!pg) {
      throw new Error('No legacy database');
    }
    return JSON.parse(JSON.stringify(await readPgliteMcpTaskRows(pg)));
  }

  async function hostStore(): Promise<StateStore> {
    const root = await mkdtemp(join(tmpdir(), 'bs-mcp-legacy-tasks-'));
    roots.push(root);
    const store = await StateStore.open(root);
    stores.push(store);
    return store;
  }

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.close();
    }
    for (const root of roots.splice(0)) {
      await rm(root, { force: true, recursive: true });
    }
    await pg?.close();
    pg = undefined;
  });

  it('moves every row once, and the host resumes the pending task under the live authority', async () => {
    const legacy = await legacyDatabase();
    const retired = await legacy.openAuthority({
      ...scope,
      connectionGeneration: 7,
      runtimeId: 'desktop-main-runtime',
    });
    const stranded = await legacy.create(
      { ...identity(retired, 'stranded'), status: 'working' },
      retired
    );
    const live = await legacy.openAuthority({
      ...scope,
      connectionGeneration: 8,
      runtimeId: 'desktop-main-runtime',
    });
    const pending = await legacy.create(
      {
        ...identity(live, 'pending'),
        inputMetadata: { prompt: 'choose a workspace' },
        status: 'input_required',
      },
      live
    );
    await legacy.create({ ...identity(live, 'done'), status: 'working' }, live);
    const done = await legacy.update(
      identity(live, 'done'),
      { resultMetadata: { answer: 42 }, status: 'completed', statusMessage: 'Finished' },
      live
    );

    const store = await hostStore();
    const read = vi.fn(mainRows);
    await importLegacyMcpTasks(store, read);
    await importLegacyMcpTasks(store, read);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(store.mcpTasks({ operation: 'legacy-import-status' })).resolves.toEqual({
      rows: [{ at: expect.any(String), authorities: 2, tasks: 3 }],
    });
    // A repeated import is a no-op on the writer itself, not only in its caller.
    await expect(
      store.mcpTasks({
        at: new Date().toISOString(),
        authorities: [],
        operation: 'legacy-import',
        tasks: [],
      })
    ).resolves.toEqual({ rows: [] });

    const host = new McpTaskStore(stateStoreMcpTaskStorage(store));
    await expect(host.get(identity(retired, 'stranded'))).resolves.toEqual(stranded);
    await expect(host.get(identity(live, 'pending'))).resolves.toEqual(pending);
    await expect(host.get(identity(live, 'done'))).resolves.toEqual(done);
    const rebound = await host.openAuthority({
      ...scope,
      connectionGeneration: 1,
      runtimeId: 'agent-host-runtime',
    });
    expect(rebound.authorityEpoch).toBe(live.authorityEpoch);
    await expect(host.listActive(rebound)).resolves.toEqual([pending]);
  });

  it('imports a legacy authority retired when the host already holds that scope live', async () => {
    const legacy = await legacyDatabase();
    const desktop = await legacy.openAuthority({
      ...scope,
      connectionGeneration: 3,
      runtimeId: 'desktop-main-runtime',
    });
    const pending = await legacy.create(
      {
        ...identity(desktop, 'pending'),
        inputMetadata: { prompt: 'pick' },
        status: 'input_required',
      },
      desktop
    );

    const store = await hostStore();
    const host = new McpTaskStore(stateStoreMcpTaskStorage(store));
    const hostAuthority = await host.openAuthority({
      ...scope,
      connectionGeneration: 1,
      runtimeId: 'agent-host-runtime',
    });
    await importLegacyMcpTasks(store, mainRows);

    await expect(host.get(identity(desktop, 'pending'))).resolves.toEqual(pending);
    await expect(host.listActive(hostAuthority)).resolves.toEqual([]);
    const reopened = await host.openAuthority({
      ...scope,
      connectionGeneration: 1,
      runtimeId: 'agent-host-runtime',
    });
    expect(reopened.authorityEpoch).toBe(hostAuthority.authorityEpoch);
  });

  it('refuses the whole import over one invalid row, leaving the next open to retry', async () => {
    const legacy = await legacyDatabase();
    const authority = await legacy.openAuthority({
      ...scope,
      connectionGeneration: 1,
      runtimeId: 'desktop-main-runtime',
    });
    const pending = await legacy.create(
      {
        ...identity(authority, 'pending'),
        inputMetadata: { prompt: 'pick' },
        status: 'input_required',
      },
      authority
    );
    const store = await hostStore();
    const host = new McpTaskStore(stateStoreMcpTaskStorage(store));
    const corrupt = async (): Promise<unknown> => {
      const rows = (await mainRows()) as { tasks: Record<string, unknown>[] };
      return { ...rows, tasks: rows.tasks.map((row) => ({ ...row, input_metadata: null })) };
    };

    await expect(importLegacyMcpTasks(store, corrupt)).rejects.toThrow(/CHECK constraint/u);
    await expect(host.get(identity(authority, 'pending'))).resolves.toBeNull();
    await expect(store.mcpTasks({ operation: 'legacy-import-status' })).resolves.toEqual({
      rows: [],
    });

    await importLegacyMcpTasks(store, mainRows);
    await expect(host.get(identity(authority, 'pending'))).resolves.toEqual(pending);
  });
});
