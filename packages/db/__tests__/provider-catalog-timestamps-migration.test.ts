import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';

interface ColumnTypeRow {
  column_name: string;
  data_type: string;
  table_name: string;
}

interface CountRow {
  count: number | string;
}

interface TimestampEpochRow {
  created_epoch: number | string;
  updated_epoch: number | string;
}

interface ProviderModelReadRow {
  model_id: string;
  model_updated_type: string;
  provider_id: string;
  provider_updated_type: string;
}

interface ProviderModelTimestampRow {
  model_created_at: string;
  model_updated_at: string;
  provider_created_at: string;
  provider_updated_at: string;
}

const LEGACY_PROVIDER_CREATED_AT = '2026-04-27T12:34:56.789123Z';
const LEGACY_PROVIDER_UPDATED_AT = '2026-04-27T13:45:01.123456Z';
const LEGACY_MODEL_CREATED_AT = '2026-04-26T08:15:00.500789Z';
const LEGACY_MODEL_UPDATED_AT = '2026-04-26T09:30:10.250987Z';

function epochSeconds(value: string): number {
  const isoMatch =
    /^(?<wholeSecond>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d+))?Z$/.exec(value);
  if (!isoMatch?.groups) {
    throw new Error(`Unsupported ISO timestamp fixture: ${value}`);
  }
  const wholeSecondEpoch = Date.parse(`${isoMatch.groups.wholeSecond}Z`) / 1000;
  const fractionalSeconds =
    isoMatch.groups.fraction === undefined ? 0 : Number(`0.${isoMatch.groups.fraction}`);
  return wholeSecondEpoch + fractionalSeconds;
}

function expectEpochCloseTo(actual: number | string, expectedIso: string): void {
  expect(Number(actual)).toBeCloseTo(epochSeconds(expectedIso), 6);
}

describe('provider catalog timestamp migration', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = `/tmp/pglite-test-provider-catalog-timestamps-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
  });

  afterEach(async () => {
    await db.close();
  });

  it('normalizes provider and model catalog timestamps to timestamptz without losing existing data', {
    timeout: 60_000,
  }, async () => {
    await runner.up(migrations.filter((migration) => migration.version < 31));

    const beforeTypes = await db.query<ColumnTypeRow>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('providers', 'models')
        AND column_name IN ('created_at', 'updated_at')
      ORDER BY table_name, column_name
    `);
    expect(beforeTypes.rows).toEqual([
      { table_name: 'models', column_name: 'created_at', data_type: 'text' },
      { table_name: 'models', column_name: 'updated_at', data_type: 'text' },
      { table_name: 'providers', column_name: 'created_at', data_type: 'text' },
      { table_name: 'providers', column_name: 'updated_at', data_type: 'text' },
    ]);

    await db.query(
      `
        UPDATE providers
        SET created_at = $1, updated_at = $2
        WHERE id = 'openai'
      `,
      [LEGACY_PROVIDER_CREATED_AT, LEGACY_PROVIDER_UPDATED_AT]
    );
    await db.query(
      `
        UPDATE models
        SET created_at = $1, updated_at = $2
        WHERE id = 'gpt-5.2'
      `,
      [LEGACY_MODEL_CREATED_AT, LEGACY_MODEL_UPDATED_AT]
    );

    const preparedRows = await db.query<CountRow>(
      `
        SELECT COUNT(*)::int AS count
        FROM providers
        INNER JOIN models ON models.provider_id = providers.id
        WHERE providers.id = 'openai'
          AND providers.created_at = $1
          AND providers.updated_at = $2
          AND models.id = 'gpt-5.2'
          AND models.created_at = $3
          AND models.updated_at = $4
      `,
      [
        LEGACY_PROVIDER_CREATED_AT,
        LEGACY_PROVIDER_UPDATED_AT,
        LEGACY_MODEL_CREATED_AT,
        LEGACY_MODEL_UPDATED_AT,
      ]
    );
    expect(Number(preparedRows.rows[0]?.count ?? 0)).toBe(1);

    const migration = migrations.find((candidate) => candidate.version === 31);
    expect(migration).toBeDefined();
    if (!migration) {
      throw new Error('Migration 031 is missing');
    }
    await runner.runMigration(migration);

    const afterTypes = await db.query<ColumnTypeRow>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('providers', 'models')
        AND column_name IN ('created_at', 'updated_at')
      ORDER BY table_name, column_name
    `);
    expect(afterTypes.rows).toEqual([
      { table_name: 'models', column_name: 'created_at', data_type: 'timestamp with time zone' },
      { table_name: 'models', column_name: 'updated_at', data_type: 'timestamp with time zone' },
      {
        table_name: 'providers',
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
      },
      {
        table_name: 'providers',
        column_name: 'updated_at',
        data_type: 'timestamp with time zone',
      },
    ]);

    const providerTime = await db.query<TimestampEpochRow>(`
      SELECT
        EXTRACT(EPOCH FROM created_at) AS created_epoch,
        EXTRACT(EPOCH FROM updated_at) AS updated_epoch
      FROM providers
      WHERE id = 'openai'
    `);
    expectEpochCloseTo(
      providerTime.rows[0]?.created_epoch ?? Number.NaN,
      LEGACY_PROVIDER_CREATED_AT
    );
    expectEpochCloseTo(
      providerTime.rows[0]?.updated_epoch ?? Number.NaN,
      LEGACY_PROVIDER_UPDATED_AT
    );

    const modelTime = await db.query<TimestampEpochRow>(`
      SELECT
        EXTRACT(EPOCH FROM created_at) AS created_epoch,
        EXTRACT(EPOCH FROM updated_at) AS updated_epoch
      FROM models
      WHERE id = 'gpt-5.2'
    `);
    expectEpochCloseTo(modelTime.rows[0]?.created_epoch ?? Number.NaN, LEGACY_MODEL_CREATED_AT);
    expectEpochCloseTo(modelTime.rows[0]?.updated_epoch ?? Number.NaN, LEGACY_MODEL_UPDATED_AT);

    const catalogRead = await db.query<ProviderModelReadRow>(`
      SELECT
        providers.id AS provider_id,
        models.id AS model_id,
        pg_typeof(providers.updated_at)::text AS provider_updated_type,
        pg_typeof(models.updated_at)::text AS model_updated_type
      FROM providers
      INNER JOIN models ON models.provider_id = providers.id
      WHERE providers.id = 'openai' AND models.id = 'gpt-5.2'
    `);
    expect(catalogRead.rows).toEqual([
      {
        provider_id: 'openai',
        model_id: 'gpt-5.2',
        provider_updated_type: 'timestamp with time zone',
        model_updated_type: 'timestamp with time zone',
      },
    ]);

    await runner.rollback(migration);

    const downTypes = await db.query<ColumnTypeRow>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('providers', 'models')
        AND column_name IN ('created_at', 'updated_at')
      ORDER BY table_name, column_name
    `);
    expect(downTypes.rows).toEqual(beforeTypes.rows);

    const rolledBackCatalogRead = await db.query<ProviderModelTimestampRow>(`
      SELECT
        providers.created_at AS provider_created_at,
        providers.updated_at AS provider_updated_at,
        models.created_at AS model_created_at,
        models.updated_at AS model_updated_at
      FROM providers
      INNER JOIN models ON models.provider_id = providers.id
      WHERE providers.id = 'openai' AND models.id = 'gpt-5.2'
    `);
    expect(rolledBackCatalogRead.rows).toEqual([
      {
        provider_created_at: LEGACY_PROVIDER_CREATED_AT,
        provider_updated_at: LEGACY_PROVIDER_UPDATED_AT,
        model_created_at: LEGACY_MODEL_CREATED_AT,
        model_updated_at: LEGACY_MODEL_UPDATED_AT,
      },
    ]);
  });
});
