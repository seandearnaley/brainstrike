import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import {
  applyTursoSchemaBaseline,
  TURSO_SCHEMA_BASELINE_CHECKSUM,
  TURSO_SCHEMA_BASELINE_VERSION,
} from '../src/turso/schema-baseline.js';

describe('Turso schema baseline', () => {
  let tempDir: string;
  let client: TursoOwnerClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-schema-'));
    client = await createTursoOwnerClient({
      dbPath: join(tempDir, 'profile.db'),
    });
  });

  afterEach(async () => {
    await client.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  it('creates the greenfield Turso schema and separate schema ledger', async () => {
    await applyTursoSchemaBaseline(client);

    await expect(listTables()).resolves.toEqual(
      expect.arrayContaining([
        'brainstrike_turso_schema_ledger',
        'brainstrike_assistant_run_usage',
        'collection_indexing_stats',
        'embedding_cache',
        'embedding_sets',
        'file_chunks',
        'file_records',
        'file_relationships',
        'file_tags',
        'file_token_cache',
        'job_queue',
        'models',
        'providers',
        'roots',
        'selection_snapshot_files',
        'selection_snapshots',
        'token_cache',
        'view_filter_presets',
      ])
    );
    await expect(listTables()).resolves.not.toEqual(
      expect.arrayContaining(['_migrations', '__drizzle_migrations'])
    );
    await expect(listIndexes('view_filter_presets')).resolves.toEqual(
      expect.arrayContaining([
        'idx_view_filter_presets_is_default',
        'idx_view_filter_presets_sort_order',
      ])
    );
    await expect(listIndexes('job_queue')).resolves.toEqual(
      expect.arrayContaining([
        'idx_job_queue_active_embed_chunk_id',
        'idx_job_queue_embed_set_state',
        'idx_job_queue_state_run_at',
      ])
    );
    await expect(client.query('PRAGMA table_info(file_chunks)')).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ name: 'embedding', type: 'BLOB' })]),
    });
    await expect(
      client.query('SELECT version, checksum FROM brainstrike_turso_schema_ledger')
    ).resolves.toEqual({
      rows: [
        {
          checksum: TURSO_SCHEMA_BASELINE_CHECKSUM,
          version: TURSO_SCHEMA_BASELINE_VERSION,
        },
      ],
    });
  });

  it('seeds catalog and view filter defaults idempotently while preserving user toggles', async () => {
    await applyTursoSchemaBaseline(client);
    await client.exec("UPDATE models SET is_enabled = 0 WHERE id = 'gpt-5.2'");
    await applyTursoSchemaBaseline(client);

    await expect(
      client.query<{ count: number }>('SELECT COUNT(*) AS count FROM view_filter_presets')
    ).resolves.toEqual({ rows: [{ count: 7 }] });
    await expect(
      client.query<{ includes: string; excludes: string }>(
        "SELECT includes, excludes FROM view_filter_presets WHERE id = 'typescript-javascript'"
      )
    ).resolves.toEqual({
      rows: [
        {
          excludes: JSON.stringify([
            'node_modules',
            'dist',
            'build',
            '.next',
            'coverage',
            '*.test.*',
            '*.spec.*',
          ]),
          includes: JSON.stringify(['*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs']),
        },
      ],
    });
    await expect(
      client.query<{ is_enabled: number }>("SELECT is_enabled FROM models WHERE id = 'gpt-5.2'")
    ).resolves.toEqual({ rows: [{ is_enabled: 0 }] });
  });

  it('fails closed when a Postgres or PGlite migration ledger is present', async () => {
    await client.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)');

    await expect(applyTursoSchemaBaseline(client)).rejects.toThrow(
      'Turso schema baseline cannot run with Postgres/PGlite migration ledgers present: __drizzle_migrations.'
    );
  });

  it('fails closed when the recorded checksum drifts', async () => {
    await client.exec(`
      CREATE TABLE brainstrike_turso_schema_ledger (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    await client.exec(
      'INSERT INTO brainstrike_turso_schema_ledger (version, checksum, applied_at) VALUES (?, ?, ?)',
      [TURSO_SCHEMA_BASELINE_VERSION, 'bad-checksum', '2026-06-22T00:00:00.000Z']
    );

    await expect(applyTursoSchemaBaseline(client)).rejects.toThrow(
      `Turso schema baseline ${TURSO_SCHEMA_BASELINE_VERSION} checksum mismatch`
    );
  });

  async function listTables(): Promise<readonly string[]> {
    const result = await client.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    return result.rows.map((row) => row.name);
  }

  async function listIndexes(tableName: string): Promise<readonly string[]> {
    const result = await client.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name",
      [tableName]
    );
    return result.rows.map((row) => row.name);
  }
});
