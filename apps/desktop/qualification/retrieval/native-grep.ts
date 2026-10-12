/**
 * BST-1939 Phase 0: product grep over the runner's native index, run as
 * Electron-as-Node so the killable SQLite reader process (Electron's SQLite)
 * and its client share one V8 serialization format.
 *
 *   ELECTRON_RUN_AS_NODE=1 electron native-grep.ts <index.sqlite> <rootId> <queries.json> <out.json>
 *
 * Each query is the whole frozen query as one case-insensitive literal, as
 * Explorer and hybrid search send it; at most 100 rows return in path, chunk order.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { SqliteQueryClient, spawnQueryProcess } from '@brainstrike/sqlite-query';
import { z } from 'zod';

const [databasePath, rootId, queriesPath, outPath] = process.argv.slice(2);
if (!(databasePath && rootId && queriesPath && outPath)) {
  throw new Error('Usage: native-grep.ts <index.sqlite> <rootId> <queries.json> <out.json>');
}
const queries = z.array(z.string().min(1)).parse(JSON.parse(await readFile(queriesPath, 'utf8')));
const environment: Record<string, string> = {};
environment['ELECTRON_RUN_AS_NODE'] = '1';
const client = await SqliteQueryClient.open({
  databasePath,
  deadlineMs: 60_000,
  spawn: () => spawnQueryProcess({ environment, executable: process.execPath }),
  startupDeadlineMs: 30_000,
});
try {
  const results = [];
  for (const query of queries) {
    const found = await client.grep({
      caseSensitive: false,
      isRegex: false,
      maxRows: 100,
      pattern: query,
      rootIds: [rootId],
    });
    results.push({
      columns: found.columns,
      matchedChunks: found.matchedChunks,
      query,
      rows: found.rows,
    });
  }
  await writeFile(outPath, JSON.stringify(results));
} finally {
  await client.close();
}
