import { afterEach, expect, test } from 'vitest';
import type { McpTaskDomainRequest } from '../src/mcp-task-types.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(cleanupDirs);

/**
 * Greenfield (BST-1930): there are no users, so the host imports no desktop
 * PGlite Tasks rows. The StateStore has no import operation and no completion
 * marker to consult.
 */
test('the MCP Tasks domain refuses a legacy import and its status read', async () => {
  const store = await StateStore.open(freshDir('m3-mcp-task-no-legacy-import'));
  try {
    for (const operation of ['legacy-import', 'legacy-import-status']) {
      await expect(
        store.mcpTasks({ operation } as unknown as McpTaskDomainRequest)
      ).rejects.toThrow('Unknown MCP task operation');
    }
  } finally {
    await store.close();
  }
});
