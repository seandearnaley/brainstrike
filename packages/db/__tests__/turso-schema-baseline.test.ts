import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrainstrikeDbExecutionClient,
  BrainstrikeDbQueryResult,
  BrainstrikeDbTransactionClient,
} from '../src/architecture/brainstrike-db-client-contract.js';
import { createTursoOwnerClient, type TursoOwnerClient } from '../src/turso/owner-client.js';
import {
  applyTursoSchemaBaseline,
  TURSO_SCHEMA_BASELINE_CHECKSUM,
  TURSO_SCHEMA_BASELINE_DDL,
  TURSO_SCHEMA_BASELINE_PREVIOUS_CHECKSUM,
  TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION,
  TURSO_SCHEMA_BASELINE_SEED_DML,
  TURSO_SCHEMA_BASELINE_V2_CHECKSUM,
  TURSO_SCHEMA_BASELINE_V2_VERSION,
  TURSO_SCHEMA_BASELINE_VERSION,
} from '../src/turso/schema-baseline.js';
import { computeTursoSchemaChecksum } from '../src/turso/schema-ledger.js';

const DB_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
        'idx_job_queue_dedupe_active',
        'idx_job_queue_embed_set_state',
        'idx_job_queue_state_run_at',
      ])
    );
    await expect(client.query('PRAGMA table_info(file_chunks)')).resolves.toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ name: 'embedding', type: 'BLOB' })]),
    });
    await expect(
      client.query<{ name: string; notnull: number; type: string }>(
        'PRAGMA table_info(brainstrike_assistant_run_usage)'
      )
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ name: 'run_id', notnull: 1, type: 'TEXT' }),
        expect.objectContaining({ name: 'resource_id', notnull: 1, type: 'TEXT' }),
        expect.objectContaining({ name: 'model', notnull: 1, type: 'TEXT' }),
        expect.objectContaining({ name: 'provider', notnull: 1, type: 'TEXT' }),
        expect.objectContaining({ name: 'root_id', type: 'TEXT' }),
      ]),
    });
    const usageColumnNames = await columnNames('brainstrike_assistant_run_usage');
    expect(usageColumnNames).not.toEqual(
      expect.arrayContaining(['message_id', 'provider_id', 'model_id'])
    );
    await expect(
      client.exec(`
        INSERT INTO brainstrike_assistant_run_usage (
          id,
          thread_id,
          run_id,
          resource_id,
          model,
          provider,
          input_tokens,
          output_tokens
        )
        VALUES ('usage-1', 'thread-1', 'run-1', 'resource-1', 'gpt-5.5', 'openai', -1, 0)
      `)
    ).rejects.toThrow();
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
    await expect(currentModelIds()).resolves.toEqual(
      expect.arrayContaining([
        'gpt-5.5',
        'gpt-5.4-mini',
        'claude-sonnet-4-6',
        'gemini-3.5-flash',
        'gemini-embedding-2',
        'openai/gpt-5.5',
        'anthropic/claude-sonnet-4.6',
      ])
    );
    await expect(currentModelIds()).resolves.not.toEqual(
      expect.arrayContaining(['claude-sonnet-4-5'])
    );
    await expect(
      client.query<{ id: string; name: string }>(
        "SELECT id, name FROM providers WHERE id IN ('google', 'local') ORDER BY id"
      )
    ).resolves.toEqual({
      rows: [
        { id: 'google', name: 'Google AI Studio' },
        { id: 'local', name: 'Local (Browser)' },
      ],
    });
    await expect(
      client.query<{ id: string; parameters: string }>(
        "SELECT id, parameters FROM models WHERE id IN ('Xenova/all-MiniLM-L6-v2', 'onnx-community/gemma-4-E2B-it-ONNX') ORDER BY id"
      )
    ).resolves.toEqual({
      rows: [
        {
          id: 'Xenova/all-MiniLM-L6-v2',
          parameters: JSON.stringify({ size: '~23MB' }),
        },
        {
          id: 'onnx-community/gemma-4-E2B-it-ONNX',
          parameters: JSON.stringify({
            architecture: 'Gemma 4 E2B',
            device: 'webgpu',
            quantization: 'q4f16',
            size: '~3.9GB (text-only q4f16)',
          }),
        },
      ],
    });
  });

  it('enforces final root and managed-cache identity uniqueness', async () => {
    await applyTursoSchemaBaseline(client);

    await expect(listIndexes('roots')).resolves.toEqual(
      expect.arrayContaining(['idx_roots_path_identity'])
    );
    await expect(listIndexes('file_records')).resolves.toEqual(
      expect.arrayContaining(['idx_file_records_root_identity'])
    );

    await client.exec(
      "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-path-1', 'path', 'Project', '/workspace/project')"
    );
    await expect(
      client.exec(
        "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-path-2', 'path', 'Project copy', '/workspace/project')"
      )
    ).rejects.toThrow();

    await client.exec(
      "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fsa-1', 'fsa', 'Project', 'project')"
    );
    await expect(
      client.exec(
        "INSERT INTO roots (id, kind, display_name, path) VALUES ('root-fsa-2', 'fsa', 'Project copy', 'project')"
      )
    ).resolves.toBeUndefined();

    await client.exec(`
      INSERT INTO file_records (id, name, path, root_id, size, embedding_set_id)
      VALUES ('file-1', 'index.ts', 'src/index.ts', 'root-path-1', 1, 'workspace-index')
    `);
    await expect(
      client.exec(`
        INSERT INTO file_records (id, name, path, root_id, size, embedding_set_id)
        VALUES ('file-2', 'index.ts', 'src/index.ts', 'root-path-1', 2, 'workspace-index')
      `)
    ).rejects.toThrow();
  });

  it('enforces one protected workspace index embedding set', async () => {
    await applyTursoSchemaBaseline(client);

    await expect(listIndexes('embedding_sets')).resolves.toEqual(
      expect.arrayContaining(['idx_embedding_sets_workspace_index_system_role'])
    );

    await client.exec(`
      INSERT INTO embedding_sets (
        id,
        model_key,
        model_id,
        dimensions,
        distance,
        name,
        system_role
      )
      VALUES (
        'workspace-index-set-1',
        'local::Xenova/all-MiniLM-L6-v2',
        'Xenova/all-MiniLM-L6-v2',
        384,
        'cosine',
        'Workspace Index',
        'workspace-index'
      )
    `);
    await expect(
      client.exec(`
        INSERT INTO embedding_sets (
          id,
          model_key,
          model_id,
          dimensions,
          distance,
          name,
          system_role
        )
        VALUES (
          'workspace-index-set-2',
          'local::Xenova/all-MiniLM-L6-v2',
          'Xenova/all-MiniLM-L6-v2',
          384,
          'cosine',
          'Duplicate Workspace Index',
          'workspace-index'
        )
      `)
    ).rejects.toThrow();
  });

  it('upgrades an existing v1 Turso schema ledger to the current baseline without checksum drift', async () => {
    const previousBaselineDdl = TURSO_SCHEMA_BASELINE_DDL.filter(
      (ddl) =>
        !(
          ddl.includes('idx_embedding_sets_workspace_index_system_role') ||
          ddl.includes('idx_job_queue_dedupe_active')
        )
    );
    for (const ddl of previousBaselineDdl) {
      await client.exec(ddl);
    }
    for (const statement of TURSO_SCHEMA_BASELINE_SEED_DML) {
      await client.exec(statement.sql, statement.params);
    }
    await client.exec(`
      CREATE TABLE brainstrike_turso_schema_ledger (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    await client.exec(
      'INSERT INTO brainstrike_turso_schema_ledger (version, checksum, applied_at) VALUES (?, ?, ?)',
      [
        TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION,
        TURSO_SCHEMA_BASELINE_PREVIOUS_CHECKSUM,
        '2026-06-22T00:00:00.000Z',
      ]
    );

    await applyTursoSchemaBaseline(client);

    await expect(listIndexes('embedding_sets')).resolves.toEqual(
      expect.arrayContaining(['idx_embedding_sets_workspace_index_system_role'])
    );
    await expect(listIndexes('job_queue')).resolves.toEqual(
      expect.arrayContaining(['idx_job_queue_dedupe_active'])
    );
    await expect(
      client.query('SELECT version, checksum FROM brainstrike_turso_schema_ledger ORDER BY version')
    ).resolves.toEqual({
      rows: [
        {
          checksum: TURSO_SCHEMA_BASELINE_PREVIOUS_CHECKSUM,
          version: TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION,
        },
        {
          checksum: TURSO_SCHEMA_BASELINE_CHECKSUM,
          version: TURSO_SCHEMA_BASELINE_VERSION,
        },
      ],
    });
  });

  it('upgrades an existing v2 Turso schema ledger with the previous checksum to the current baseline', async () => {
    const oldV2BaselineDdl = TURSO_SCHEMA_BASELINE_DDL.filter(
      (ddl) => !ddl.includes('idx_job_queue_dedupe_active')
    );
    for (const ddl of oldV2BaselineDdl) {
      await client.exec(ddl);
    }
    for (const statement of TURSO_SCHEMA_BASELINE_SEED_DML) {
      await client.exec(statement.sql, statement.params);
    }
    await client.exec(`
      CREATE TABLE brainstrike_turso_schema_ledger (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    await client.exec(
      'INSERT INTO brainstrike_turso_schema_ledger (version, checksum, applied_at) VALUES (?, ?, ?)',
      [
        TURSO_SCHEMA_BASELINE_V2_VERSION,
        TURSO_SCHEMA_BASELINE_V2_CHECKSUM,
        '2026-06-22T12:00:00.000Z',
      ]
    );

    await applyTursoSchemaBaseline(client);

    await expect(listIndexes('job_queue')).resolves.toEqual(
      expect.arrayContaining(['idx_job_queue_dedupe_active'])
    );
    await expect(
      client.query('SELECT version, checksum FROM brainstrike_turso_schema_ledger ORDER BY version')
    ).resolves.toEqual({
      rows: [
        {
          checksum: TURSO_SCHEMA_BASELINE_V2_CHECKSUM,
          version: TURSO_SCHEMA_BASELINE_V2_VERSION,
        },
        {
          checksum: TURSO_SCHEMA_BASELINE_CHECKSUM,
          version: TURSO_SCHEMA_BASELINE_VERSION,
        },
      ],
    });
  });

  it('includes seed parameters in the baseline checksum', () => {
    const sqlOnlyChecksum = computeTursoSchemaChecksum([
      ...TURSO_SCHEMA_BASELINE_DDL,
      ...TURSO_SCHEMA_BASELINE_SEED_DML.map((statement) => statement.sql),
    ]);

    expect(TURSO_SCHEMA_BASELINE_CHECKSUM).not.toBe(sqlOnlyChecksum);
  });

  it('pins the historical v2 checksum instead of deriving it from mutable baseline declarations', async () => {
    expect(TURSO_SCHEMA_BASELINE_V2_CHECKSUM).toBe(
      '9886965b9577881c6af49ffd179c43d25eada1622390d4c223d6bc4e2e92bd1a'
    );

    const source = await readFile(join(DB_PACKAGE_ROOT, 'src/turso/schema-baseline.ts'), 'utf8');
    const v2ChecksumDeclaration = source.match(
      /TURSO_SCHEMA_BASELINE_V2_CHECKSUM\s*=[\s\S]*?;\n/
    )?.[0];

    expect(v2ChecksumDeclaration).toContain(
      "'9886965b9577881c6af49ffd179c43d25eada1622390d4c223d6bc4e2e92bd1a'"
    );
    expect(v2ChecksumDeclaration).not.toContain('computeTursoSchemaChecksum');
  });

  it('enables foreign key enforcement before opening the baseline transaction', async () => {
    const calls: string[] = [];
    const fakeClient = createRecordingExecutionClient(calls);

    await applyTursoSchemaBaseline(fakeClient);

    expect(calls.slice(0, 2)).toEqual(['outer:PRAGMA foreign_keys = ON', 'transaction:begin']);
    expect(calls).not.toContain('tx:PRAGMA foreign_keys = ON');
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

  it('fails closed when a previous baseline checksum drifts', async () => {
    await client.exec(`
      CREATE TABLE brainstrike_turso_schema_ledger (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);
    await client.exec(
      'INSERT INTO brainstrike_turso_schema_ledger (version, checksum, applied_at) VALUES (?, ?, ?)',
      [TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION, 'bad-checksum', '2026-06-22T00:00:00.000Z']
    );

    await expect(applyTursoSchemaBaseline(client)).rejects.toThrow(
      `Turso schema baseline ${TURSO_SCHEMA_BASELINE_PREVIOUS_VERSION} checksum mismatch`
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

  async function columnNames(tableName: string): Promise<readonly string[]> {
    const result = await client.query<{ name: string }>(`PRAGMA table_info(${tableName})`);
    return result.rows.map((row) => row.name);
  }

  async function currentModelIds(): Promise<readonly string[]> {
    const result = await client.query<{ id: string }>('SELECT id FROM models ORDER BY id');
    return result.rows.map((row) => row.id);
  }

  function createRecordingExecutionClient(calls: string[]): BrainstrikeDbExecutionClient {
    const transactionClient: BrainstrikeDbTransactionClient = {
      exec: async (sql) => {
        calls.push(`tx:${normalizeSql(sql)}`);
      },
      query: async <TRecord>(sql: string): Promise<BrainstrikeDbQueryResult<TRecord>> => {
        calls.push(`tx-query:${normalizeSql(sql)}`);
        return { rows: [] };
      },
    };
    return {
      exec: async (sql) => {
        calls.push(`outer:${normalizeSql(sql)}`);
      },
      query: async <TRecord>(sql: string): Promise<BrainstrikeDbQueryResult<TRecord>> => {
        calls.push(`outer-query:${normalizeSql(sql)}`);
        return { rows: [] };
      },
      transaction: async <TResult>(
        callback: (tx: BrainstrikeDbTransactionClient) => Promise<TResult>
      ): Promise<TResult> => {
        calls.push('transaction:begin');
        const result = await callback(transactionClient);
        calls.push('transaction:commit');
        return result;
      },
    };
  }

  function normalizeSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }
});
