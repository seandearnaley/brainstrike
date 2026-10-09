import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { type PgliteLegacyMemory, readPgliteLegacyMemory } from '@brainstrike/db';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

/**
 * Node → Main (gap 17): the desktop's legacy workspace memory, read once for
 * the host's import into its StateStore. It goes when PGlite leaves the desktop.
 */
export const LEGACY_MEMORY_METHOD = 'platform/memory/legacy';

/** Main's PGlite workspace memory: legacy read only the workspace resource. */
export async function readMainLegacyMemory(): Promise<PgliteLegacyMemory> {
  const { getDatabase } = await import('../db-main');
  const database = await getDatabase();
  return await readPgliteLegacyMemory(
    { query: (sql, params) => database.query(sql, params) },
    WORKSPACE_MEMORY_RESOURCE_ID
  );
}

/** Serve the host's one legacy memory read on its private platform connection. */
export function serveLegacyMemory(
  connection: MessageConnection,
  read: () => Promise<PgliteLegacyMemory>
): { close(): void } {
  const handler = connection.onRequest(LEGACY_MEMORY_METHOD, async (input: unknown) => {
    z.strictObject({}).parse(input);
    return await read();
  });
  return { close: () => handler.dispose() };
}
