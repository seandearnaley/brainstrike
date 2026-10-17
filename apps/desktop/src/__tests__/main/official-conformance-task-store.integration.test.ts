// @vitest-environment node
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpTaskStore } from '@brainstrike/assistant-contract/mcp-task-store';
import { describe, expect, it } from 'vitest';
import { createEphemeralConformanceTaskStore } from '../../mcp/official-conformance-task-store';

const ROOT_PREFIX = 'brainstrike-mcp-conformance-';

function conformanceRoots(): ReadonlySet<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(ROOT_PREFIX)));
}

function added(before: ReadonlySet<string>): string[] {
  return [...conformanceRoots()].filter((name) => !before.has(name));
}

describe('the official conformance client MCP Tasks store', () => {
  it('opens one StateStore on first use, serves Tasks from it and removes its root at close', async () => {
    const before = conformanceRoots();
    const taskStore = createEphemeralConformanceTaskStore();
    expect(added(before)).toEqual([]);

    const tasks = new McpTaskStore(await taskStore.open());
    const root = added(before);
    expect(root).toHaveLength(1);
    const authority = await tasks.openAuthority({
      connectionGeneration: 1,
      principalId: 'conformance-principal',
      resource: 'https://tasks.example.test/',
      runtimeId: 'conformance-runtime',
      serverId: 'official-conformance',
    });
    const identity = {
      authorityEpoch: authority.authorityEpoch,
      principalId: authority.principalId,
      resource: authority.resource,
      serverId: authority.serverId,
      taskId: 'conformance-task',
    } as const;
    const created = await tasks.create({ ...identity, status: 'working' }, authority);
    await expect(tasks.get(identity)).resolves.toEqual(created);

    // A later connection reuses the same store rather than opening a second root.
    await expect(new McpTaskStore(await taskStore.open()).get(identity)).resolves.toEqual(created);
    expect(added(before)).toEqual(root);

    await taskStore.close();
    expect(added(before)).toEqual([]);
  });

  it('closes without opening anything when no connection used Tasks', async () => {
    const before = conformanceRoots();
    const taskStore = createEphemeralConformanceTaskStore();
    await expect(taskStore.close()).resolves.toBeUndefined();
    expect(added(before)).toEqual([]);
  });
});
