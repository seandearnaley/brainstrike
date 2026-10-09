import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { McpTaskLeaseWire } from '../src/mcp-task-types.js';
import { STATE_DB, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { byteSearch } from './helpers/testkit.js';
import { TruthIndexer } from './helpers/truth-indexer.js';

const THREAD = 'recorded-mcp-task-thread';
const BOUND_SECRET = 'recorded-M3-thread-bound-mcp-task-input';
const IMPORTED_SECRET = 'recorded-M3-imported-desktop-mcp-task-input';
const AT = new Date('2026-10-08T19:00:00Z').toISOString();

afterEach(cleanupDirs);

function pendingTask(taskId: string, secret: string, threadId: string | null) {
  return {
    at: AT,
    blockedDiagnostic: null,
    history: JSON.stringify([{ at: AT, status: 'input_required' }]),
    inputMetadata: JSON.stringify({ prompt: secret }),
    resultMetadata: null,
    status: 'input_required' as const,
    statusMessage: null,
    taskId,
    terminalAt: null,
    threadId,
  };
}

/**
 * MCP Tasks rows (BST-1930 ruling B) leave no byte behind: deleting a thread
 * erases the task rows its runs created, and factory reset removes the rows
 * that belong to no thread, the desktop's imported PGlite rows among them.
 */
test('thread delete erases its MCP task rows; reset erases the profile-scoped and imported rows', async () => {
  const root = freshDir('m3-mcp-task-erasure');
  const indexer = new TruthIndexer(root);
  const store = await StateStore.open(root, { indexer });
  try {
    await store.append([{ event: { type: 'thread.started' }, threadId: THREAD }]);
    const opened = await store.mcpTasks({
      at: AT,
      authorityEpoch: randomUUID(),
      input: {
        connectionGeneration: 1,
        principalId: 'lab:principal',
        resource: 'https://lab.example/mcp',
        runtimeId: 'agent-host-runtime',
        serverId: 'lab.tasks',
      },
      operation: 'open-authority',
    });
    const authority = opened.rows[0];
    const lease: McpTaskLeaseWire = {
      authorityEpoch: String(authority?.['authority_epoch']),
      connectionGeneration: 1,
      principalId: 'lab:principal',
      resource: 'https://lab.example/mcp',
      runtimeId: 'agent-host-runtime',
      serverId: 'lab.tasks',
    };
    await store.mcpTasks({
      lease,
      operation: 'insert',
      row: pendingTask('bound', BOUND_SECRET, THREAD),
    });
    const importedEpoch = randomUUID();
    await store.mcpTasks({
      at: AT,
      authorities: [
        {
          authorityEpoch: importedEpoch,
          connectionGeneration: 3,
          createdAt: AT,
          principalId: 'linear:user-42',
          resource: 'https://mcp.linear.app/mcp',
          retiredAt: null,
          runtimeId: 'desktop-main-runtime',
          serverId: 'linear',
          updatedAt: AT,
        },
      ],
      operation: 'legacy-import',
      tasks: [
        {
          ...pendingTask('imported', IMPORTED_SECRET, null),
          authorityEpoch: importedEpoch,
          createdAt: AT,
          principalId: 'linear:user-42',
          resource: 'https://mcp.linear.app/mcp',
          serverId: 'linear',
          updatedAt: AT,
        },
      ],
    });
    expect(byteSearch(root, BOUND_SECRET).total).toBeGreaterThan(0);
    expect(byteSearch(root, IMPORTED_SECRET).total).toBeGreaterThan(0);

    await store.deleteThread(THREAD);
    expect(byteSearch(root, BOUND_SECRET)).toEqual({ files: {}, total: 0 });
    await expect(
      store.mcpTasks({ identity: { ...lease, taskId: 'bound' }, operation: 'get' })
    ).resolves.toEqual({ rows: [] });
    // A row no thread created survives thread deletion; only reset clears it.
    expect(byteSearch(root, IMPORTED_SECRET).total).toBeGreaterThan(0);

    await store.reset();
    expect(existsSync(join(root, STATE_DB))).toBe(false);
    expect(byteSearch(root, IMPORTED_SECRET)).toEqual({ files: {}, total: 0 });
  } finally {
    await store.close();
    indexer.close();
  }
});
