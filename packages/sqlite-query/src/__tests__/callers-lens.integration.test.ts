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
import { SqliteQueryClient, spawnQueryProcess } from '../../dist/index.js';

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
  expectedVectorIds = makeThrowingDecoder(
    Schema.Struct({ expectedVectorIds: Schema.Array(Schema.String) })
  )(JSON.parse(seeded.stdout)).expectedVectorIds;
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
const requirement = { kind: 'caller-vectors', symbol: 'add' } as const;

describe('canonical SQLite caller lens over recorded renderer/parser payloads', () => {
  it('binds seed/terms and ranks only exact caller graph chunks with their source spans', async () => {
    expect(lens.target).toBe('index');
    expect(lens.requirement).toEqual({ kind: 'caller-vectors', seedParam: 'symbol' });
    const coerced = coerceLensValues(lens.params, ['add', 'disposer bridge']);
    expect(coerced).toEqual({ ok: true, values: ['add', 'disposer bridge'] });
    const result = await client.query(sql, { bindings, maxRows: 100 });
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
          requirement,
        })
      ).rows.map((row) => row[0])
    ).toEqual(expectedVectorIds);
    expect((await client.query(sql, { bindings, maxRows: 100, requirement })).rows).toEqual(
      result.rows
    );
  });
  it('refuses the required caller vector arm when a graph chunk has no vector', async () => {
    const writer = new DatabaseSync(databasePath, { allowExtension: true });
    writer.loadExtension(sqliteVecExtensionPath());
    const saved = writer
      .prepare(
        "SELECT v.* FROM vec_chunks v JOIN file_chunks ch ON ch.pk=v.id WHERE ch.file_record_id='recorded-file-1' ORDER BY ch.id LIMIT 1"
      )
      .get();
    if (
      !(
        saved &&
        typeof saved['id'] === 'number' &&
        typeof saved['root_id'] === 'string' &&
        saved['bin'] instanceof Uint8Array &&
        saved['emb'] instanceof Uint8Array
      )
    ) {
      throw new Error('Recorded caller vector must exist.');
    }
    writer.prepare('DELETE FROM vec_chunks WHERE id=?').run(saved['id']);
    writer.prepare('UPDATE file_chunks SET has_vector=0 WHERE pk=?').run(saved['id']);
    try {
      await expect(client.query(sql, { bindings, requirement })).rejects.toThrow(
        'complete vectors'
      );
    } finally {
      writer
        .prepare('INSERT INTO vec_chunks(id,root_id,bin,emb) VALUES(?,?,vec_bit(?),?)')
        .run(BigInt(saved['id']), saved['root_id'], saved['bin'], saved['emb']);
      writer.prepare('UPDATE file_chunks SET has_vector=1 WHERE pk=?').run(saved['id']);
      writer.close();
    }
  });

  it('refuses a missing seed rather than returning an empty lexical result', async () => {
    await expect(
      client.query(sql, {
        bindings: { ...bindings, ['$1']: 'missingSeed' },
        requirement: { kind: 'caller-vectors', symbol: 'missingSeed' },
      })
    ).rejects.toThrow('seed symbol');
  });

  it('refuses an unconfigured vector profile and keeps user transaction control denied', async () => {
    const writer = new DatabaseSync(databasePath);
    const original = writer.prepare('SELECT profile_json,profile_hash FROM index_metadata').get();
    if (
      !(
        original &&
        typeof original['profile_json'] === 'string' &&
        typeof original['profile_hash'] === 'string'
      )
    ) {
      throw new Error('Recorded configured profile must exist.');
    }
    writer.exec(
      "UPDATE index_metadata SET index_mode='text-only',profile_json=NULL,profile_hash=NULL"
    );
    try {
      await expect(client.query(sql, { bindings, requirement })).rejects.toThrow(
        'configured complete vector profile'
      );
    } finally {
      writer
        .prepare(
          "UPDATE index_metadata SET index_mode='vector-configured',profile_json=?,profile_hash=?"
        )
        .run(original['profile_json'], original['profile_hash']);
      writer.close();
    }
    await expect(client.query('BEGIN', { requirement })).rejects.toThrow('not authorized');
    await expect(client.query('ROLLBACK')).rejects.toThrow('not authorized');
    expect((await client.query(sql, { bindings, maxRows: 100, requirement })).rows).toHaveLength(8);
  });

  it.each(['many', 'depth'])(
    'preserves the actual engine %s control for arm caps or recursion depth',
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
          requirement: { kind: 'caller-vectors', symbol } as const,
        };
        const result = await owned.query(sql, options);
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
        requirement: { kind: 'caller-vectors', symbol: hostile },
      })
    ).rejects.toThrow('seed symbol');
    expect((await client.query('SELECT count(*) FROM file_symbols')).rows[0]?.[0]).toBeGreaterThan(
      0
    );
    const writer = new DatabaseSync(databasePath, { allowExtension: true });
    writer.loadExtension(sqliteVecExtensionPath());
    const saved = writer
      .prepare(
        "SELECT v.id,v.emb FROM vec_chunks v JOIN file_chunks ch ON ch.pk=v.id WHERE ch.file_record_id='recorded-file-1' ORDER BY ch.id LIMIT 1"
      )
      .get();
    if (!(saved && typeof saved['id'] === 'number' && saved['emb'] instanceof Uint8Array)) {
      throw new Error('Recorded caller vector must exist.');
    }
    const nonfinite = Buffer.from(saved['emb']);
    nonfinite.writeFloatLE(Number.NaN, 0);
    try {
      for (const [bytes, message] of [
        [nonfinite, 'finite vector components'],
        [Buffer.alloc(384 * 4), 'nonzero vectors'],
        [Buffer.alloc(4), 'configured dimension'],
      ] as const) {
        writer.prepare('UPDATE vec_chunks SET emb=? WHERE id=?').run(bytes, BigInt(saved['id']));
        await expect(client.query(sql, { bindings, requirement })).rejects.toThrow(message);
      }
    } finally {
      writer
        .prepare('UPDATE vec_chunks SET emb=? WHERE id=?')
        .run(saved['emb'], BigInt(saved['id']));
      writer.close();
    }
    expect((await client.query(sql, { bindings, maxRows: 100, requirement })).rows).toHaveLength(8);
  });
});
