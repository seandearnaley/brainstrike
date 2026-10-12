import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { coerceLensValues, parseLensFile } from '@brainstrike/assistant-contract';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { sqliteVecExtensionPath } from '@brainstrike/sqlite-native';
import { Schema } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SqliteCallerContext,
  SqliteQueryClient,
  spawnQueryProcess,
} from '../../dist/index.js';

const directory = mkdtempSync(resolve(tmpdir(), 'brainstrike-callers-lens-'));
const databasePath = resolve(directory, 'index.sqlite');
const content = readFileSync(resolve('../../.brainstrike/lenses/callers-hybrid.sql'), 'utf8');
const parsed = parseLensFile('callers-hybrid.sql', content);
if (!parsed.ok) {
  throw new Error(parsed.error);
}
const lens = parsed.lens;
const sql = lens.sql;
let client: SqliteQueryClient;
let expectedVectorIds: readonly string[];
let context: SqliteCallerContext;
const decodeFixture = makeThrowingDecoder(
  Schema.Struct({
    context: Schema.Struct({
      collectionId: Schema.String,
      fileIds: Schema.Array(Schema.String),
      profile: Schema.Unknown,
      storeId: Schema.String,
    }),
    expectedVectorIds: Schema.Array(Schema.String),
  })
);

beforeAll(async () => {
  const writer = process.env['INDEXER_TEST_EXEC_PATH'];
  const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
  if (!(writer && executable)) {
    throw new Error(
      'Explicit qualified Node writer and Electron sandbox executables are required.'
    );
  }
  const seeded = spawnSync(
    writer,
    ['src/__tests__/fixtures/build-callers-index.mjs', databasePath],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    }
  );
  if (seeded.status !== 0) {
    throw new Error(`Canonical IndexPort fixture failed: ${seeded.stderr}`);
  }
  ({ expectedVectorIds, context } = decodeFixture(JSON.parse(seeded.stdout)));
  client = await SqliteQueryClient.open({
    databasePath,
    deadlineMs: 5000,
    spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
    startupDeadlineMs: 5000,
  });
}, 20_000);

afterAll(async () => {
  await client?.close();
  rmSync(directory, { force: true, recursive: true });
});

const bindings = { ['$1']: 'add', ['$2']: 'disposer bridge' };
function requirement(symbol = 'add') {
  return { context, kind: 'caller-vectors', symbol } as const;
}

describe('canonical SQLite caller lens over recorded renderer/parser payloads', () => {
  it('binds seed/terms and ranks only exact caller graph chunks with their source spans', async () => {
    expect(lens.target).toBe('index');
    expect(lens.requirement).toEqual({ kind: 'caller-vectors', seedParam: 'symbol' });
    const coerced = coerceLensValues(lens.params, ['add', 'disposer bridge']);
    expect(coerced).toEqual({ ok: true, values: ['add', 'disposer bridge'] });
    const result = await client.query(sql, { bindings, maxRows: 100, requirement: requirement() });
    expect(result.columns).toEqual(['path', 'chunk_id', 'start_line', 'end_line', 'rrf_score']);
    expect(result.rows).toHaveLength(8);
    expect(new Set(result.rows.map((row) => row[0]))).toEqual(
      new Set([
        'apps/desktop/src/main/disposer-stack.ts',
        'apps/desktop/src/mcp/apps-shell-bridge.ts',
        'apps/desktop/src/mcp/bridges.ts',
      ])
    );
    const stored = await client.query(
      "SELECT id,start_line,end_line FROM file_chunks WHERE file_record_id<>'bait'",
      { maxRows: 100 }
    );
    for (const row of result.rows) {
      expect(stored.rows).toContainEqual(row.slice(1, 4));
      expect(row[4]).toBeGreaterThan(0);
    }
    expect(result.truncated).toBe(false);
    const prefix = sql.slice(0, sql.lastIndexOf('SELECT fr.path'));
    expect(
      (
        await client.query(`${prefix} SELECT id FROM vector_arm ORDER BY position`, {
          bindings,
          maxRows: 100,
          requirement: requirement(),
        })
      ).rows.map((row) => row[0])
    ).toEqual(expectedVectorIds);
    expect(
      (await client.query(sql, { bindings, maxRows: 100, requirement: requirement() })).rows
    ).toEqual(result.rows);
  });
  it('refuses the required caller vector arm when a graph chunk has no vector', async () => {
    const writer = new DatabaseSync(databasePath, { allowExtension: true });
    writer.loadExtension(sqliteVecExtensionPath());
    const saved = writer
      .prepare(
        "SELECT v.* FROM scoped_vectors v JOIN file_chunks ch ON ch.pk=v.chunk_pk WHERE ch.file_record_id='recorded-file-1' ORDER BY ch.id LIMIT 1"
      )
      .get();
    if (
      !(
        saved &&
        typeof saved['pk'] === 'number' &&
        typeof saved['chunk_pk'] === 'number' &&
        typeof saved['profile_hash'] === 'string' &&
        typeof saved['content_hash'] === 'string' &&
        typeof saved['dimensions'] === 'number' &&
        saved['emb'] instanceof Uint8Array
      )
    ) {
      throw new Error('Recorded scoped vector must exist.');
    }
    writer
      .prepare('DELETE FROM scoped_vectors WHERE chunk_pk=? AND profile_hash=?')
      .run(saved['chunk_pk'], saved['profile_hash']);
    try {
      await expect(client.query(sql, { bindings, requirement: requirement() })).rejects.toThrow(
        'complete vectors'
      );
    } finally {
      writer
        .prepare(
          'INSERT INTO scoped_vectors(pk,chunk_pk,profile_hash,content_hash,dimensions,emb) VALUES(?,?,?,?,?,?)'
        )
        .run(
          saved['pk'],
          saved['chunk_pk'],
          saved['profile_hash'],
          saved['content_hash'],
          saved['dimensions'],
          saved['emb']
        );
      writer.close();
    }
  });

  it('refuses a missing seed rather than returning an empty lexical result', async () => {
    await expect(
      client.query(sql, {
        bindings: { ...bindings, ['$1']: 'missingSeed' },
        requirement: requirement('missingSeed'),
      })
    ).rejects.toThrow('seed symbol');
  });

  it('requires current profile authority while keeping global metadata TEXT and transaction control denied', async () => {
    expect(
      (await client.query('SELECT index_mode,profile_json,profile_hash FROM index_metadata')).rows
    ).toEqual([['text-only', null, null]]);
    await expect(
      client.query(sql, { bindings, requirement: { kind: 'caller-vectors', symbol: 'add' } })
    ).rejects.toThrow('explicit current collection');
    await expect(
      client.query(sql, {
        bindings,
        requirement: {
          ...requirement(),
          context: {
            ...context,
            profile: { ...(context.profile as Record<string, unknown>), modelId: 'wrong-profile' },
          },
        },
      })
    ).rejects.toThrow('stored scoped profile');
    await expect(client.query('BEGIN', { requirement: requirement() })).rejects.toThrow(
      'not authorized'
    );
    await expect(client.query('ROLLBACK')).rejects.toThrow('not authorized');
    expect(
      (await client.query(sql, { bindings, maxRows: 100, requirement: requirement() })).rows
    ).toHaveLength(8);
  });

  it.each(['many', 'depth', 'rootless'])(
    'preserves the actual engine %s caller control',
    async (mode) => {
      const dbPath = resolve(directory, `${mode}.sqlite`);
      const writer = process.env['INDEXER_TEST_EXEC_PATH'];
      const executable = process.env['SQLITE_QUERY_TEST_EXEC_PATH'];
      if (!(writer && executable)) {
        throw new Error('Explicit qualified runtimes are required.');
      }
      const seeded = spawnSync(
        writer,
        ['src/__tests__/fixtures/build-callers-index.mjs', dbPath, mode],
        {
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        }
      );
      if (seeded.status !== 0) {
        throw new Error(`Canonical control fixture failed: ${seeded.stderr}`);
      }
      const owned = await SqliteQueryClient.open({
        databasePath: dbPath,
        deadlineMs: 5000,
        spawn: () => spawnQueryProcess({ environment: { ELECTRON_RUN_AS_NODE: '1' }, executable }),
        startupDeadlineMs: 5000,
      });
      try {
        const symbol = mode === 'depth' ? 'hop0' : 'add';
        const options = {
          bindings: { ['$1']: symbol, ['$2']: 'add OR bridge OR disposer' },
          maxRows: 100,
          requirement: {
            context: decodeFixture(JSON.parse(seeded.stdout)).context,
            kind: 'caller-vectors',
            symbol,
          } as const,
        };
        const result = await owned.query(sql, options);
        if (mode === 'rootless') {
          // Real canonical collection publication: no synthetic workspace root/path.
          const source = await owned.query(
            "SELECT id,start_line,end_line,root_id FROM file_chunks WHERE file_record_id<>'bait'",
            { maxRows: 100 }
          );
          expect(source.rows).toHaveLength(8);
          expect(source.rows.every((row) => row[3] === null)).toBe(true);
          expect(result.rows).toHaveLength(8);
          expect(result.rows.every((row) => row[0] === null)).toBe(true);
          expect(new Set(result.rows.map((row) => row[1]))).toEqual(
            new Set(decodeFixture(JSON.parse(seeded.stdout)).expectedVectorIds)
          );
          for (const row of result.rows) {
            expect(source.rows.map((stored) => stored.slice(0, 3))).toContainEqual(row.slice(1, 4));
            expect(row[4]).toBeGreaterThan(0);
          }
          const membership = await owned.query(
            "SELECT count(*) FROM file_records WHERE root_id IS NULL AND path IS NULL AND scoped=1 AND embedding_set_id='recorded-collection' AND source_path IS NOT NULL"
          );
          expect(membership.rows).toEqual([[options.requirement.context.fileIds.length]]);
          return;
        }
        if (mode === 'depth') {
          expect(result.rows).toHaveLength(33);
          expect(new Set(result.rows.map((row) => row[0]))).toEqual(
            new Set([
              'apps/desktop/src/main/disposer-stack.ts',
              ...Array.from({ length: 10 }, (_, index) => `control/depth-${index + 1}.ts`),
            ])
          );
          return;
        }
        const prefix = sql.slice(0, sql.lastIndexOf('SELECT fr.path'));
        for (const arm of ['bm25_arm', 'vector_arm']) {
          expect(
            (
              await owned.query(
                `${prefix} SELECT count(*),min(position),max(position) FROM ${arm}`,
                options
              )
            ).rows
          ).toEqual([[50, 1, 50]]);
        }
        const ranked = await owned.query(
          `${prefix} SELECT id,position FROM bm25_arm UNION ALL SELECT id,position FROM vector_arm`,
          options
        );
        const expected = new Map<string, number>();
        for (const [id, position] of ranked.rows) {
          if (typeof id !== 'string' || typeof position !== 'number') {
            throw new Error('Native arm must preserve exact chunk IDs and numeric ranks.');
          }
          expected.set(id, (expected.get(id) ?? 0) + 1 / (60 + position));
        }
        expect(new Set(result.rows.map((row) => row[1]))).toEqual(new Set(expected.keys()));
        for (const row of result.rows) {
          expect(typeof row[1]).toBe('string');
          expect(row[4]).toBe(expected.get(String(row[1])));
        }
        expect(result.rows.map((row) => row[4])).toEqual(
          [...result.rows.map((row) => row[4])].sort((a, b) => Number(b) - Number(a))
        );
      } finally {
        await owned.close();
      }
    }
  );

  it('keeps hostile symbols bound and refuses corrupted Float32 vector payloads', async () => {
    const hostile = "add'; DELETE FROM file_symbols; --";
    await expect(
      client.query(sql, {
        bindings: { ...bindings, ['$1']: hostile },
        requirement: requirement(hostile),
      })
    ).rejects.toThrow('seed symbol');
    expect((await client.query('SELECT count(*) FROM file_symbols')).rows[0]?.[0]).toBeGreaterThan(
      0
    );
    const writer = new DatabaseSync(databasePath, { allowExtension: true });
    writer.loadExtension(sqliteVecExtensionPath());
    const saved = writer
      .prepare(
        "SELECT v.chunk_pk AS id,v.profile_hash,v.emb FROM scoped_vectors v JOIN file_chunks ch ON ch.pk=v.chunk_pk WHERE ch.file_record_id='recorded-file-1' ORDER BY ch.id LIMIT 1"
      )
      .get();
    if (
      !(
        saved &&
        typeof saved['id'] === 'number' &&
        typeof saved['profile_hash'] === 'string' &&
        saved['emb'] instanceof Uint8Array
      )
    ) {
      throw new Error('Recorded caller vector must exist.');
    }
    // Deliberate corrupt-storage controls must reach the reader guard, including invalid byte length.
    writer.exec('PRAGMA ignore_check_constraints=ON');
    const nonfinite = Buffer.from(saved['emb']);
    nonfinite.writeFloatLE(Number.NaN, 0);
    try {
      for (const [bytes, message] of [
        [nonfinite, 'finite vector components'],
        [Buffer.alloc(384 * 4), 'nonzero vectors'],
        [Buffer.alloc(4), 'configured dimension'],
      ] as const) {
        writer
          .prepare('UPDATE scoped_vectors SET emb=? WHERE chunk_pk=? AND profile_hash=?')
          .run(bytes, saved['id'], saved['profile_hash']);
        await expect(client.query(sql, { bindings, requirement: requirement() })).rejects.toThrow(
          message
        );
      }
    } finally {
      writer
        .prepare('UPDATE scoped_vectors SET emb=? WHERE chunk_pk=? AND profile_hash=?')
        .run(saved['emb'], saved['id'], saved['profile_hash']);
      writer.close();
    }
    expect(
      (await client.query(sql, { bindings, maxRows: 100, requirement: requirement() })).rows
    ).toHaveLength(8);
  });
});
