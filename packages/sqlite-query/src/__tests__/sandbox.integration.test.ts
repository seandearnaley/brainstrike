import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planGrepTrigramCandidates } from '@brainstrike/utils/grep-trigram-plan';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type QueryProcess,
  type SqliteGrepOptions,
  SqliteQueryClient,
  SqliteQueryDeadlineError,
  spawnQueryProcess,
} from '../../dist/index.js';
import { NATIVE_TRIGRAM_SCHEMA } from './fixtures/native-trigram-schema.js';

const directory = mkdtempSync(join(tmpdir(), 'brainstrike-sqlite-query-'));
const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
const clients: SqliteQueryClient[] = [];

interface BuiltIndex {
  readonly chunkIds: Readonly<Record<string, readonly string[]>>;
}

/** Commits the fixture through the real IndexerPort writer under its qualified Node. */
function buildIndex(databasePath: string, mode?: 'append'): BuiltIndex {
  const writer = process.env['INDEXER_TEST_EXEC_PATH'];
  if (!writer) {
    throw new Error('An explicit qualified Node writer executable is required.');
  }
  const built = spawnSync(
    writer,
    ['src/__tests__/fixtures/build-lifecycle-index.mjs', databasePath, ...(mode ? [mode] : [])],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }
  );
  if (built.status !== 0) {
    throw new Error(`Real IndexerPort fixture failed: ${built.stderr}`);
  }
  return JSON.parse(built.stdout) as BuiltIndex;
}

/** Opens a grep reader in a real query process and reports that process's pid. */
async function open(
  databasePath: string,
  deadlineMs = 1000
): Promise<{ readonly client: SqliteQueryClient; readonly pid: number }> {
  if (!executable) {
    throw new Error('SQLITE_QUERY_TEST_EXEC_PATH must identify a qualified Electron executable.');
  }
  let owned: QueryProcess | undefined;
  const client = await SqliteQueryClient.open({
    databasePath,
    deadlineMs,
    spawn: () => {
      owned = spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable });
      return owned;
    },
    startupDeadlineMs: 5000,
  });
  clients.push(client);
  const pid = owned?.pid;
  if (pid === undefined) {
    throw new Error('The query process reported no pid.');
  }
  return { client, pid };
}

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

const indexPath = join(directory, 'index.sqlite');
const hash = (): string => createHash('sha256').update(readFileSync(indexPath)).digest('hex');
let index: BuiltIndex;
let originalHash: string;
const proof = (pattern: string, overrides: Partial<SqliteGrepOptions> = {}): SqliteGrepOptions => ({
  caseSensitive: true,
  isRegex: false,
  maxRows: 100,
  pattern,
  rootIds: ['proof-root'],
  ...overrides,
});
// Quadratic backtracking over runaway-root's 300,000-character line: tens of seconds.
// `\w` overlaps `\d`, so V8 cannot make the `+` atomic as it does for `[a-z]+[0-9]`.
const runaway: SqliteGrepOptions = {
  caseSensitive: true,
  isRegex: true,
  maxRows: 1,
  pattern: String.raw`\w+\d`,
  rootIds: ['runaway-root'],
};
const ids = (rows: readonly (readonly unknown[])[]): unknown[] => rows.map((row) => row[0]).sort();
const settle = (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error);

beforeAll(() => {
  index = buildIndex(indexPath);
  // The writer closed, so its WAL is checkpointed into the main file hashed and copied here.
  expect(existsSync(`${indexPath}-wal`)).toBe(false);
  originalHash = hash();
}, 60_000);

afterAll(async () => {
  await Promise.allSettled(clients.map((owned) => owned.close()));
  rmSync(directory, { force: true, recursive: true });
});

describe('grep reader over a real IndexerPort index', () => {
  it('runs every production grep statement shape through the real authorizer', async () => {
    // Fail closed: the authorizer admits only the functions and pragma grep's own
    // statements use. The first BST-1997 draft dropped PRAGMA data_version, which
    // FTS5 reads before every trigram MATCH, and every trigram grep was refused.
    // A new function or pragma in grep's SQL fails here, not for a user.
    const { client } = await open(indexPath);
    const [cafe, alphabet] = index.chunkIds['proof'] ?? [];
    const both = [cafe, alphabet].sort();
    const shapes: readonly {
      readonly expected: readonly (string | undefined)[];
      readonly filter: 'trigram' | 'instr' | 'lower' | 'none';
      readonly options: SqliteGrepOptions;
    }[] = [
      { expected: both, filter: 'trigram', options: proof('alpha') },
      { expected: both, filter: 'instr', options: proof('al') },
      { expected: both, filter: 'lower', options: proof('AL', { caseSensitive: false }) },
      {
        expected: [alphabet],
        filter: 'none',
        options: proof(String.raw`^a\w+t$`, { isRegex: true }),
      },
      { expected: [cafe], filter: 'trigram', options: proof('café', { caseSensitive: false }) },
    ];
    for (const { expected, filter, options } of shapes) {
      const plan = planGrepTrigramCandidates(
        options.pattern,
        options.isRegex,
        options.caseSensitive
      );
      expect({ filter, plan: plan.kind }).toEqual({
        filter,
        plan: filter === 'trigram' ? 'candidates' : 'scan',
      });
      for (const scope of [{}, { fileIds: ['proof'], rootIds: [] }]) {
        const result = await client.grep({ ...options, ...scope });
        expect({ filter, ids: ids(result.rows), scope }).toEqual({ filter, ids: expected, scope });
      }
    }
    expect((await client.grep(proof('alpha', { fileIds: [], rootIds: [] }))).rows).toEqual([]);
    expect(hash()).toBe(originalHash);
  });

  it('keeps hostile patterns and scopes as bound values and leaves the index bytes unchanged', async () => {
    const { client } = await open(indexPath);
    for (const options of [
      proof("x'; DROP TABLE file_chunks; --"),
      proof('"alpha" OR *', { caseSensitive: false }),
      proof(String.raw`alpha"\) OR \("a`, { isRegex: true }),
      proof('alpha', { rootIds: ["x') OR 1=1 OR ('"] }),
      proof('alpha', { fileIds: ["x') OR 1=1 OR ('"], rootIds: [] }),
    ]) {
      const result = await client.grep(options);
      expect({ options, rows: result.rows }).toEqual({ options, rows: [] });
    }
    expect(ids((await client.grep(proof('alpha'))).rows)).toEqual(
      [...(index.chunkIds['proof'] ?? [])].sort()
    );
    expect(hash()).toBe(originalHash);
  });

  it('refuses an oversized grep result before the parent reads it and keeps the reader', async () => {
    const { client } = await open(indexPath);
    const wide = { ...proof('budget'), maxRows: 200, rootIds: ['wide-root'] };
    await expect(client.grep(wide)).rejects.toThrow('process-message budget');
    const capped = await client.grep({ ...wide, maxRows: 100 });
    expect(capped.rows).toHaveLength(100);
    expect(capped.matchedChunks).toBe(210);
    expect(capped.truncated).toBe(true);
  });

  it('kills a runaway grep at its deadline, keeps that error, and lets the real writer commit for a fresh reader', async () => {
    const appendPath = join(directory, 'append.sqlite');
    copyFileSync(indexPath, appendPath);
    const { client: doomed, pid } = await open(appendPath, 150);
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    let deadline: unknown;
    try {
      deadline = await settle(doomed.grep(runaway));
    } finally {
      clearInterval(interval);
    }
    expect(deadline).toBeInstanceOf(SqliteQueryDeadlineError);
    expect(ticks).toBeGreaterThan(3);
    await doomed.close();
    expect(exited(pid)).toBe(true);
    await expect(doomed.grep(proof('alpha'))).rejects.toBe(deadline);
    const appended = buildIndex(appendPath, 'append');
    const { client: fresh } = await open(appendPath);
    expect(ids((await fresh.grep(proof('writer remains'))).rows)).toEqual(
      appended.chunkIds['afterKill']
    );
  });

  it('owner close stops an in-flight grep and resolves only after the reader exits', async () => {
    // Host Stop, reset and shutdown stop index reads this way (closeAllIndexQueries).
    const { client, pid } = await open(indexPath, 60_000);
    const inflight = settle(client.grep(runaway));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = performance.now();
    await client.close();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(exited(pid)).toBe(true);
    expect(await inflight).toMatchObject({ message: 'SQLite query client is closed.' });
    expect(hash()).toBe(originalHash);
  });

  it('a reader crash rejects the in-flight grep and leaves the client dead', async () => {
    const { client, pid } = await open(indexPath, 60_000);
    const inflight = settle(client.grep(runaway));
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(pid, 'SIGKILL');
    const crash = await inflight;
    expect(crash).toMatchObject({ message: 'SQLite query process exited.' });
    await expect(client.grep(proof('alpha'))).rejects.toBe(crash);
    await client.close();
    expect(hash()).toBe(originalHash);
  });
});

describe('grep reader over hand-built index metadata', () => {
  it('runs canonical literal and regex grep over authorized native chunk identities', async () => {
    const grepPath = join(directory, 'grep.sqlite');
    const writer = new DatabaseSync(grepPath);
    writer.exec(`CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
      INSERT INTO index_metadata VALUES(1,8,'${'a'.repeat(64)}','text-only',NULL,NULL);
      CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT);
      CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
    ${NATIVE_TRIGRAM_SCHEMA}
      INSERT INTO file_records VALUES('f-a','root-a','a.ts'),('f-b','root-b','b.ts');
      INSERT INTO file_chunks VALUES('chunk-1','root-a','f-a','CAFÉ Alpha','hash-1',1,1,0,10,'text',0,10,3),('chunk-2','root-a','f-a','alphabet','hash-2',2,2,1,8,'text',11,19,1),('chunk-3','root-b','f-b','café alpha','hash-3',1,1,0,10,'text',0,10,3);`);
    writer.close();
    if (!executable) {
      throw new Error('Qualified integration executable is required.');
    }
    const grepClient = await SqliteQueryClient.open({
      databasePath: grepPath,
      deadlineMs: 1000,
      spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
      startupDeadlineMs: 5000,
    });
    try {
      const literal = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'café',
        rootIds: ['root-a'],
      });
      expect(literal.rows.map((row) => row[0])).toEqual(['chunk-1']);
      expect(literal).toHaveProperty('identity', {
        embedding: { indexMode: 'text-only' },
        storeId: 'a'.repeat(64),
      });
      expect(literal.matchedChunks).toBe(1);
      expect(literal.truncated).toBe(false);
      expect(
        (
          await grepClient.grep({
            caseSensitive: true,
            isRegex: false,
            maxRows: 100,
            pattern: 'café',
            rootIds: ['root-a'],
          })
        ).rows
      ).toEqual([]);
      expect(
        (
          await grepClient.grep({
            caseSensitive: false,
            isRegex: true,
            maxRows: 100,
            pattern: String.raw`\balpha\b`,
            rootIds: ['root-a'],
          })
        ).rows.map((row) => row[0])
      ).toEqual(['chunk-1']);
      const capped = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 1,
        pattern: 'alpha',
        rootIds: ['root-a'],
      });
      expect(capped.rows.map((row) => row[0])).toEqual(['chunk-1']);
      expect(capped.matchedChunks).toBe(2);
      expect(capped.truncated).toBe(true);
      const emptyScope = await grepClient.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'alpha',
        rootIds: ['empty-root'],
      });
      expect(emptyScope.rows).toEqual([]);
      expect(emptyScope.matchedChunks).toBe(0);
      expect(emptyScope.identity).toEqual(literal.identity);
      const metadataWriter = new DatabaseSync(grepPath);
      try {
        // Common reads retain identity across supported historical/current schemas.
        for (const version of [9, 10]) {
          metadataWriter.prepare('UPDATE index_metadata SET schema_version=?').run(version);
          expect(
            await grepClient.grep({
              caseSensitive: false,
              isRegex: false,
              maxRows: 100,
              pattern: 'café',
              rootIds: ['root-a'],
            })
          ).toEqual(literal);
        }
        // Malformed metadata remains a fatal refusal, separate from compatibility.
        metadataWriter.exec('UPDATE index_metadata SET schema_version=3');
        await expect(
          grepClient.grep({
            caseSensitive: false,
            isRegex: false,
            maxRows: 100,
            pattern: 'alpha',
            rootIds: ['root-a'],
          })
        ).rejects.toThrow('Existing index metadata is invalid:');
        metadataWriter.exec('UPDATE index_metadata SET schema_version=8');
        expect(
          await grepClient.grep({
            caseSensitive: false,
            isRegex: false,
            maxRows: 100,
            pattern: 'café',
            rootIds: ['root-a'],
          })
        ).toEqual(literal);
      } finally {
        metadataWriter.close();
      }

      await expect(
        grepClient.grep({
          caseSensitive: false,
          isRegex: true,
          maxRows: 100,
          pattern: '(a+)+$',
          rootIds: ['root-a'],
        })
      ).rejects.toThrow('catastrophic backtracking');
      await expect(
        grepClient.grep({
          caseSensitive: false,
          isRegex: false,
          maxRows: 100,
          pattern: 'alpha',
          rootIds: [],
        })
      ).rejects.toThrow();
    } finally {
      await grepClient.close();
    }
  });

  it('counts a valid stored vector identity in empty and matching grep responses', async () => {
    const grepPath = join(directory, 'grep-identity-budget.sqlite');
    const writer = new DatabaseSync(grepPath);
    writer.exec(`CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY,schema_version INTEGER,store_id TEXT,index_mode TEXT,profile_json TEXT,profile_hash TEXT);
      CREATE TABLE file_records(id TEXT PRIMARY KEY,root_id TEXT,path TEXT);
      CREATE TABLE file_chunks(id TEXT,root_id TEXT,file_record_id TEXT,content TEXT,content_hash TEXT,start_line INTEGER,end_line INTEGER,chunk_index INTEGER,chunk_size INTEGER,chunk_type TEXT,start_offset INTEGER,end_offset INTEGER,token_count INTEGER);
    ${NATIVE_TRIGRAM_SCHEMA}
      INSERT INTO file_records VALUES('file','root','a.ts');
      INSERT INTO file_chunks VALUES('chunk','root','file','budget match','hash',1,1,0,12,'text',0,12,2);`);
    const setProfile = (modelId: string): void => {
      const profile = {
        dimensions: 384,
        dtype: 'fp32',
        modelId,
        revision: 'a'.repeat(40),
        tokenCap: 256,
      };
      const profileHash = createHash('sha256')
        .update(
          JSON.stringify([
            profile.modelId,
            profile.revision,
            profile.dtype,
            profile.dimensions,
            profile.tokenCap,
          ])
        )
        .digest('hex');
      writer
        .prepare("INSERT OR REPLACE INTO index_metadata VALUES(1,8,?,'vector-configured',?,?)")
        .run('b'.repeat(64), JSON.stringify(profile), profileHash);
    };
    setProfile('qualified-model');
    if (!executable) {
      throw new Error('Qualified integration executable is required.');
    }
    const grepClient = await SqliteQueryClient.open({
      databasePath: grepPath,
      deadlineMs: 1000,
      spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
      startupDeadlineMs: 5000,
    });
    const options = {
      caseSensitive: false,
      isRegex: false,
      maxRows: 1,
      pattern: 'budget',
      rootIds: ['root'],
    };
    try {
      expect((await grepClient.grep(options)).rows).toHaveLength(1);
      setProfile('λ'.repeat(600_000));
      await expect(grepClient.grep({ ...options, rootIds: ['empty-root'] })).rejects.toThrow(
        'process-message budget'
      );
      await expect(grepClient.grep(options)).rejects.toThrow('process-message budget');
      setProfile('qualified-model');
      const recovered = await grepClient.grep(options);
      expect(recovered.rows).toHaveLength(1);
      expect(recovered.identity.embedding).toHaveProperty('profile.modelId', 'qualified-model');
    } finally {
      await grepClient.close();
      writer.close();
    }
  });
});
