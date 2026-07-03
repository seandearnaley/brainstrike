#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import type { TursoMastraQueryValues, TursoMastraSqlClient } from './types';
import {
  formatTursoVectorExactScanBenchmarkMarkdown,
  runTursoVectorExactScanBenchmark,
} from './vector-exact-scan-benchmark';

export interface TursoVectorExactScanBenchmarkCliOptions {
  readonly dimensions: number;
  readonly out: string;
  readonly queries: number;
  readonly rows: number;
  readonly topK: number;
  readonly warmup: number;
}

export function parseTursoVectorExactScanBenchmarkArgs(
  argv: readonly string[]
): TursoVectorExactScanBenchmarkCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (!arg?.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${String(arg)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, value);
    index += 1;
  }
  return {
    dimensions: readPositiveIntegerFlag(values, '--dimensions'),
    out: readRequiredFlag(values, '--out'),
    queries: readPositiveIntegerFlag(values, '--queries'),
    rows: readPositiveIntegerFlag(values, '--rows'),
    topK: readPositiveIntegerFlag(values, '--top-k'),
    warmup: readNonNegativeIntegerFlag(values, '--warmup', 0),
  };
}

async function main(): Promise<void> {
  const options = parseTursoVectorExactScanBenchmarkArgs(process.argv.slice(2));
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-turso-vector-bench-'));
  const database = await connect(join(tempDir, 'profile.db'));
  try {
    await database.pragma("journal_mode = 'mvcc'", {});
    await database.pragma('foreign_keys = ON', {});
    const client = createBenchmarkClient(database);
    const report = await runTursoVectorExactScanBenchmark({
      database: client,
      dimensions: options.dimensions,
      indexName: 'memory_observations_benchmark',
      queryCount: options.queries,
      rowCount: options.rows,
      topK: options.topK,
      warmupCount: options.warmup,
    });
    const command = `pnpm --filter @brainstrike/agent run bench:turso-vector-memory -- ${process.argv
      .slice(2)
      .filter((arg) => arg !== '--')
      .join(' ')}`;
    const markdown = formatTursoVectorExactScanBenchmarkMarkdown(report, {
      command,
      sourceCommit:
        process.env['GITHUB_SHA'] ?? process.env['BRAINSTRIKE_SOURCE_COMMIT'] ?? 'local',
    });
    await writeFile(options.out, markdown, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await database.close();
    await rm(tempDir, { force: true, recursive: true });
  }
}

function createBenchmarkClient(database: TursoDatabase): TursoMastraSqlClient {
  return {
    exec: async (query, values) => {
      if (values && values.length > 0) {
        await database.run(query, normalizeValues(values));
        return;
      }
      await database.exec(query);
    },
    query: async <TRecord extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      values?: TursoMastraQueryValues
    ) => {
      const rows = values
        ? await database.all(query, normalizeValues(values))
        : await database.all(query);
      return { rows: rows as TRecord[] };
    },
    transaction: async (fn) => {
      await database.exec('BEGIN CONCURRENT');
      try {
        const result = await fn(createBenchmarkClient(database));
        await database.exec('COMMIT');
        return result;
      } catch (error) {
        await rollback(database);
        throw error;
      }
    },
  };
}

function readRequiredFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPositiveIntegerFlag(values: Map<string, string>, name: string): number {
  const value = Number(readRequiredFlag(values, name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function readNonNegativeIntegerFlag(
  values: Map<string, string>,
  name: string,
  defaultValue: number
): number {
  const rawValue = values.get(name);
  if (rawValue === undefined) {
    return defaultValue;
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeValues(values: TursoMastraQueryValues): unknown[] {
  return values.map((value) => (value instanceof Date ? value.toISOString() : value));
}

async function rollback(database: TursoDatabase): Promise<void> {
  try {
    await database.exec('ROLLBACK');
  } catch {
    // Preserve the original transaction failure.
  }
}

if (process.argv[1]?.includes('vector-exact-scan-benchmark-cli')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
