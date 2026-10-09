// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseLensFile } from '@brainstrike/assistant-contract';
import {
  type SqliteCallerContext,
  SqliteQueryClient,
  spawnQueryProcess,
} from '@brainstrike/sqlite-query';
import { afterAll, expect, it, vi } from 'vitest';

vi.mock('../../db-main', () => ({
  getDatabase: () => {
    throw new Error('Caller query must use the native store.');
  },
}));
const { runQuerySelf } = await import('../../assistant-server/query-self-tool');
const directory = mkdtempSync(resolve(tmpdir(), 'brainstrike-query-self-scoped-'));
afterAll(() => rmSync(directory, { force: true, recursive: true }));

it('returns caller rows through querySelf after scoped publication with global TEXT metadata', async () => {
  const writer = process.env['INDEXER_TEST_EXEC_PATH'];
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  if (!(writer && executable)) {
    throw new Error('Explicit qualified Node writer and Electron reader are required.');
  }
  // The forked query host speaks advanced (structured-clone) IPC, so this parent must run on the
  // same Electron V8 (docs/agents/agent-self-query/scoped-caller-profile.md); under another
  // runtime every reply fails as "Unable to deserialize cloned data".
  if (process.versions['electron'] === undefined) {
    throw new Error('Run this proof under the qualified Electron with ELECTRON_RUN_AS_NODE=1.');
  }
  const databasePath = resolve(directory, 'index.sqlite');
  const seeded = spawnSync(
    writer,
    ['src/__tests__/fixtures/build-callers-index.mjs', databasePath],
    {
      cwd: resolve('../../packages/sqlite-query'),
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    }
  );
  if (seeded.status !== 0) {
    throw new Error(`Scoped publication failed: ${seeded.stderr}`);
  }
  const fixture: { context: SqliteCallerContext; info: { embedding: { indexMode: string } } } =
    JSON.parse(seeded.stdout);
  expect(fixture.info.embedding.indexMode).toBe('text-only');
  const parsed = parseLensFile(
    'callers-hybrid.sql',
    readFileSync(resolve('../../.brainstrike/lenses/callers-hybrid.sql'), 'utf8')
  );
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const client = await SqliteQueryClient.open({
    databasePath,
    deadlineMs: 5000,
    spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
    startupDeadlineMs: 5000,
  });
  expect(
    (await client.query('SELECT index_mode,profile_json,profile_hash FROM index_metadata')).rows
  ).toEqual([['text-only', null, null]]);
  const result = await runQuerySelf(
    { lens: 'callers-hybrid', mode: 'lens', target: 'index', values: ['add', 'disposer bridge'] },
    undefined,
    {
      openIndexQuery: async () => client,
      scanLenses: () => ({ entries: [], incompleteDirs: [], lenses: [parsed.lens] }),
      withIndexCallerRead: (work) => work(fixture.context),
    }
  );
  expect(result).toMatchObject({
    columns: ['path', 'chunk_id', 'start_line', 'end_line', 'rrf_score'],
    kind: 'rows',
    rowCount: 8,
    target: 'index',
  });
  if (result.kind !== 'rows') {
    throw new Error('Caller lens must return native rows.');
  }
  expect(result.rows.some((row) => row.cells[0] === 'apps/desktop/src/mcp/bridges.ts')).toBe(true);
}, 20_000);
