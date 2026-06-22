import { readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { connect, type Database as TursoDatabase } from '@tursodatabase/database';
import {
  createProfileBootstrapReport,
  failProfileBootstrapReport,
  getBlockingProfileBootstrapIssues,
  type ProfileBootstrapBlockingIssue,
  type ProfileBootstrapCheck,
  type ProfileBootstrapCheckStatus,
  type ProfileBootstrapReport,
  type ProfileBootstrapRuntime,
} from './profile-bootstrap-report.js';

export interface TursoCapabilitySpikeReport {
  readonly blockingIssues: readonly ProfileBootstrapBlockingIssue[];
  readonly bootstrapReport: ProfileBootstrapReport;
  readonly checks: readonly ProfileBootstrapCheck[];
  readonly generatedAt: string;
  readonly packageVersions: Readonly<Record<string, string>>;
  readonly reportVersion: 1;
}

export interface TursoCapabilitySpikeOptions {
  readonly dbPath: string;
  readonly generatedAt?: () => string;
  readonly profileId?: string;
}

type TursoSpikeCheckId =
  | 'package.tursodatabase-database'
  | 'package.tursodatabase-sync'
  | 'package.libsql-client'
  | 'package.drizzle-libsql-adapter'
  | 'search.fts-index'
  | 'search.fts-mvcc-compatibility'
  | 'search.vector-distance'
  | 'sql.concurrent-writes-mvcc'
  | 'sql.crud'
  | 'sql.transaction'
  | 'store.close'
  | 'store.open';

interface CheckDefinition {
  readonly id: TursoSpikeCheckId;
  readonly label: string;
  readonly required: boolean;
}

const CHECK_DEFINITIONS: readonly CheckDefinition[] = [
  {
    id: 'package.tursodatabase-database',
    label: '@tursodatabase/database package is installed',
    required: true,
  },
  {
    id: 'package.tursodatabase-sync',
    label: '@tursodatabase/sync package is installed for explicit sync evaluation',
    required: true,
  },
  {
    id: 'package.libsql-client',
    label: '@libsql/client package is installed for mature ORM comparison',
    required: true,
  },
  {
    id: 'package.drizzle-libsql-adapter',
    label: 'Drizzle libSQL adapter entrypoint resolves for comparison probes',
    required: true,
  },
  { id: 'store.open', label: 'Local Turso store opens', required: true },
  { id: 'sql.crud', label: 'Basic SQL create/insert/select/update/delete works', required: true },
  {
    id: 'sql.transaction',
    label: 'Interactive Turso transaction commits atomically',
    required: true,
  },
  {
    id: 'sql.concurrent-writes-mvcc',
    label: 'MVCC concurrent writes succeed with BEGIN CONCURRENT retry handling',
    required: true,
  },
  {
    id: 'search.vector-distance',
    label: 'Native Turso vector storage and exact top-k distance search work',
    required: true,
  },
  {
    id: 'search.fts-index',
    label: 'Turso FTS index, match, score, and highlight work',
    required: true,
  },
  {
    id: 'search.fts-mvcc-compatibility',
    label: 'Turso FTS custom indexes remain usable with MVCC concurrent writes enabled',
    required: true,
  },
  { id: 'store.close', label: 'Local Turso store closes cleanly', required: true },
] as const;

const RUNTIME: ProfileBootstrapRuntime = {
  engine: 'turso',
  host: 'node',
  persistence: 'filesystem',
};

const requireFromHere = createRequire(import.meta.url);

export async function runTursoCapabilitySpike(
  options: TursoCapabilitySpikeOptions
): Promise<TursoCapabilitySpikeReport> {
  const now = options.generatedAt ?? (() => new Date().toISOString());
  const generatedAt = now();
  const packageVersions: Record<string, string> = {};
  let checks = createPendingChecks();
  let db: TursoDatabase | null = null;
  let bootstrapReport: ProfileBootstrapReport;

  try {
    checks = await checkPackage(
      checks,
      'package.tursodatabase-database',
      '@tursodatabase/database',
      packageVersions
    );
    checks = await checkPackage(
      checks,
      'package.tursodatabase-sync',
      '@tursodatabase/sync',
      packageVersions
    );
    checks = await checkPackage(checks, 'package.libsql-client', '@libsql/client', packageVersions);
    checks = await checkResolvable(checks, 'package.drizzle-libsql-adapter', 'drizzle-orm/libsql');

    db = await connectTursoDatabase(options.dbPath);
    checks = setCheck(checks, 'store.open', 'passed');

    checks = await setCapabilityCheck(checks, 'sql.crud', () => proveCrud(db));
    checks = await setCapabilityCheck(checks, 'sql.transaction', () => proveTransaction(db));
    checks = await setCapabilityCheck(checks, 'sql.concurrent-writes-mvcc', () =>
      proveConcurrentWrites(options.dbPath)
    );
    checks = await setCapabilityCheck(checks, 'search.vector-distance', () =>
      proveVectorSearch(db)
    );
    checks = await setCapabilityCheck(checks, 'search.fts-index', () =>
      proveFts(`${options.dbPath}.fts.db`)
    );
    checks = await setCapabilityCheck(checks, 'search.fts-mvcc-compatibility', () =>
      proveFtsWithMvcc(db)
    );

    bootstrapReport = createProfileBootstrapReport({
      checks,
      phase: hasBlockingCheck(checks) ? 'blocked' : 'ready',
      profileId: options.profileId ?? 'turso-capability-spike',
      runtime: RUNTIME,
      startedAt: generatedAt,
      updatedAt: now(),
    });
  } catch (error) {
    bootstrapReport = failProfileBootstrapReport(
      createProfileBootstrapReport({
        checks,
        phase: 'probing-capabilities',
        profileId: options.profileId ?? 'turso-capability-spike',
        runtime: RUNTIME,
        startedAt: generatedAt,
        updatedAt: now(),
      }),
      {
        code: 'turso_capability_spike_failed',
        error,
        failedAt: now(),
        phase: 'probing-capabilities',
      }
    );
  }

  if (db) {
    bootstrapReport = await closeTursoDatabaseAndUpdateReport(db, bootstrapReport, now);
  }

  return createTursoCapabilitySpikeReport(bootstrapReport, packageVersions, now());
}

export function formatTursoCapabilitySpikeReportAsMarkdown(
  report: TursoCapabilitySpikeReport
): string {
  const lines = [
    '# Brainstrike Turso Capability Spike',
    '',
    `Generated: \`${report.generatedAt}\``,
    `Runtime: \`${report.bootstrapReport.runtime.engine}\` on \`${report.bootstrapReport.runtime.host}\` using \`${report.bootstrapReport.runtime.persistence}\` persistence`,
    `Phase: \`${report.bootstrapReport.phase}\``,
    `Ready: \`${String(report.bootstrapReport.ready)}\``,
    '',
    '## Package Versions',
    '',
    ...Object.entries(report.packageVersions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `- \`${name}\`: \`${version}\``),
    '',
    '| Check | Requirement | Status | Message |',
    '| --- | --- | --- | --- |',
    ...report.checks.map(
      (check) =>
        `${[
          `| \`${check.id}\``,
          check.required ? 'Required' : 'Optional',
          `\`${check.status}\``,
          check.message ?? '',
        ].join(' | ')} |`
    ),
  ];

  if (report.blockingIssues.length > 0) {
    lines.push('', '## Blocking Issues', '');
    for (const issue of report.blockingIssues) {
      lines.push(`- ${issue.message}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function createPendingChecks(): readonly ProfileBootstrapCheck[] {
  return CHECK_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    required: definition.required,
    status: 'pending',
  }));
}

async function checkPackage(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoSpikeCheckId,
  packageName: string,
  versions: Record<string, string>
): Promise<readonly ProfileBootstrapCheck[]> {
  const version = await readInstalledPackageVersion(packageName);
  versions[packageName] = version;
  return setCheck(checks, id, 'passed', `Installed ${packageName}@${version}.`);
}

async function checkResolvable(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoSpikeCheckId,
  specifier: string
): Promise<readonly ProfileBootstrapCheck[]> {
  requireFromHere.resolve(specifier);
  return setCheck(checks, id, 'passed', `Resolved ${specifier}.`);
}

async function readInstalledPackageVersion(packageName: string): Promise<string> {
  let current = dirname(requireFromHere.resolve(packageName));
  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = join(current, 'package.json');
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (packageJson.name === packageName && typeof packageJson.version === 'string') {
        return packageJson.version;
      }
    } catch {
      // Keep walking toward the package root; pnpm packages may expose only subpaths.
    }
    current = dirname(current);
  }
  throw new Error(`Could not resolve installed version for ${packageName}.`);
}

async function connectTursoDatabase(dbPath: string): Promise<TursoDatabase> {
  return connect(dbPath, {
    experimental: ['index_method'],
  } as Parameters<typeof connect>[1]);
}

async function proveCrud(db: TursoDatabase | null): Promise<boolean> {
  const database = requireOpenDatabase(db);
  await database.exec(
    'CREATE TABLE turso_crud_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'
  );
  await (await database.prepare('INSERT INTO turso_crud_probe (value) VALUES (?)')).run('alpha');
  const rows = await (
    await database.prepare('SELECT value FROM turso_crud_probe WHERE id = ?')
  ).all(1);
  await (await database.prepare('UPDATE turso_crud_probe SET value = ? WHERE id = ?')).run(
    'beta',
    1
  );
  const updated = await (
    await database.prepare('SELECT value FROM turso_crud_probe WHERE id = ?')
  ).get(1);
  await (await database.prepare('DELETE FROM turso_crud_probe WHERE id = ?')).run(1);
  const afterDelete = await (
    await database.prepare('SELECT COUNT(*) AS count FROM turso_crud_probe')
  ).get();

  return (
    rows.length === 1 &&
    rowValue(rows[0], 'value') === 'alpha' &&
    rowValue(updated, 'value') === 'beta' &&
    rowValue(afterDelete, 'count') === 0
  );
}

async function proveTransaction(db: TursoDatabase | null): Promise<boolean> {
  const database = requireOpenDatabase(db);
  await database.exec('CREATE TABLE turso_tx_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const transaction = database.transaction(async (value: string) => {
    await (await database.prepare('INSERT INTO turso_tx_probe (value) VALUES (?)')).run(value);
  });

  await transaction('committed');
  const row = await (await database.prepare('SELECT value FROM turso_tx_probe WHERE id = 1')).get();
  return rowValue(row, 'value') === 'committed';
}

async function proveConcurrentWrites(dbPath: string): Promise<boolean> {
  const setup = await connectTursoDatabase(dbPath);
  try {
    await setup.exec("PRAGMA journal_mode = 'mvcc'");
    await setup.exec('CREATE TABLE turso_concurrent_probe (worker INTEGER NOT NULL)');
  } finally {
    await setup.close();
  }

  await Promise.all(
    Array.from({ length: 4 }, (_, index) => writeConcurrentProbeRow(dbPath, index))
  );

  const verify = await connectTursoDatabase(dbPath);
  try {
    const row = await (
      await verify.prepare('SELECT COUNT(*) AS count FROM turso_concurrent_probe')
    ).get();
    return rowValue(row, 'count') === 4;
  } finally {
    await verify.close();
  }
}

async function writeConcurrentProbeRow(dbPath: string, worker: number): Promise<void> {
  const db = await connectTursoDatabase(dbPath);
  try {
    await db.exec("PRAGMA journal_mode = 'mvcc'");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.exec('BEGIN CONCURRENT');
      try {
        await (await db.prepare('INSERT INTO turso_concurrent_probe (worker) VALUES (?)')).run(
          worker
        );
        await db.exec('COMMIT');
        return;
      } catch (error) {
        await rollbackIgnoringFailure(db);
        if (!isRetryableConcurrentWriteError(error) || attempt === 4) {
          throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    await db.close();
  }
}

async function proveVectorSearch(db: TursoDatabase | null): Promise<boolean> {
  const database = requireOpenDatabase(db);
  await database.exec(`
    CREATE TABLE turso_vector_probe (
      id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
    )
  `);
  await (
    await database.prepare('INSERT INTO turso_vector_probe (id, embedding) VALUES (?, vector32(?))')
  ).run(1, '[1,0,0]');
  await (
    await database.prepare('INSERT INTO turso_vector_probe (id, embedding) VALUES (?, vector32(?))')
  ).run(2, '[0,1,0]');
  const rows = await (
    await database.prepare(`
      SELECT id, vector_distance_cos(embedding, vector32(?)) AS distance
      FROM turso_vector_probe
      ORDER BY distance ASC
      LIMIT 1
    `)
  ).all('[1,0,0]');

  return rows.length === 1 && rowValue(rows[0], 'id') === 1;
}

async function proveFts(dbPath: string): Promise<boolean> {
  await rm(dbPath, { force: true });
  const database = await connectTursoDatabase(dbPath);
  try {
    return await createAndQueryFtsIndex(database);
  } finally {
    await database.close();
  }
}

async function proveFtsWithMvcc(db: TursoDatabase | null): Promise<boolean> {
  const database = requireOpenDatabase(db);
  await database.exec("PRAGMA journal_mode = 'mvcc'");
  await database.exec(`
    CREATE TABLE turso_fts_mvcc_probe (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    )
  `);
  await database.exec(`
    CREATE INDEX turso_fts_mvcc_probe_idx
    ON turso_fts_mvcc_probe USING fts (title, body)
  `);
  return true;
}

async function createAndQueryFtsIndex(database: TursoDatabase): Promise<boolean> {
  await database.exec(`
      CREATE TABLE turso_fts_probe (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `);
  await (await database.prepare('INSERT INTO turso_fts_probe VALUES (?, ?, ?)')).run(
    1,
    'Database indexing',
    'Turso provides full text search for local agents.'
  );
  await (await database.prepare('INSERT INTO turso_fts_probe VALUES (?, ?, ?)')).run(
    2,
    'Unrelated note',
    'This row should rank lower for database queries.'
  );
  await database.exec(`
      CREATE INDEX turso_fts_probe_idx
      ON turso_fts_probe USING fts (title, body)
    `);
  const rows = await (
    await database.prepare(`
      SELECT id, fts_score(title, body, ?) AS score, fts_highlight(title, '<mark>', '</mark>', ?) AS highlight
      FROM turso_fts_probe
      WHERE fts_match(title, body, ?)
      ORDER BY score DESC
      LIMIT 1
    `)
  ).all('database', 'database', 'database');

  return (
    rows.length === 1 &&
    rowValue(rows[0], 'id') === 1 &&
    typeof rowValue(rows[0], 'score') === 'number' &&
    String(rowValue(rows[0], 'highlight')).includes('<mark>')
  );
}

async function rollbackIgnoringFailure(db: TursoDatabase): Promise<void> {
  try {
    await db.exec('ROLLBACK');
  } catch {
    // Best-effort cleanup after a failed concurrent transaction.
  }
}

function isRetryableConcurrentWriteError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('busy') || message.includes('conflict');
}

async function setCapabilityCheck(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoSpikeCheckId,
  probe: () => Promise<boolean>
): Promise<readonly ProfileBootstrapCheck[]> {
  try {
    return setCheck(checks, id, (await probe()) ? 'passed' : 'failed');
  } catch (error) {
    return setCheck(checks, id, 'failed', sanitizeSpikeCheckMessage(error));
  }
}

async function closeTursoDatabaseAndUpdateReport(
  db: TursoDatabase,
  report: ProfileBootstrapReport,
  now: () => string
): Promise<ProfileBootstrapReport> {
  let checks = report.checks;
  try {
    await db.close();
    checks = setCheck(checks, 'store.close', 'passed');
  } catch (error) {
    checks = setCheck(checks, 'store.close', 'failed', sanitizeSpikeCheckMessage(error));
  }

  return createProfileBootstrapReport({
    checks,
    failure: report.failure,
    phase: report.failure ? report.phase : hasBlockingCheck(checks) ? 'blocked' : 'ready',
    profileId: report.profileId,
    runtime: report.runtime,
    startedAt: report.startedAt,
    updatedAt: now(),
  });
}

function createTursoCapabilitySpikeReport(
  bootstrapReport: ProfileBootstrapReport,
  packageVersions: Readonly<Record<string, string>>,
  generatedAt: string
): TursoCapabilitySpikeReport {
  return {
    blockingIssues: getBlockingProfileBootstrapIssues(bootstrapReport),
    bootstrapReport,
    checks: bootstrapReport.checks,
    generatedAt,
    packageVersions,
    reportVersion: 1,
  };
}

function setCheck(
  checks: readonly ProfileBootstrapCheck[],
  id: TursoSpikeCheckId,
  status: ProfileBootstrapCheckStatus,
  message?: string
): readonly ProfileBootstrapCheck[] {
  return checks.map((check) =>
    check.id === id ? { ...check, ...(message ? { message } : {}), status } : check
  );
}

function hasBlockingCheck(checks: readonly ProfileBootstrapCheck[]): boolean {
  return checks.some((check) => check.required && check.status !== 'passed');
}

function requireOpenDatabase(db: TursoDatabase | null): TursoDatabase {
  if (!db) {
    throw new Error('Turso database is not open.');
  }
  return db;
}

function rowValue(row: unknown, key: string): unknown {
  if (!row || typeof row !== 'object') {
    return;
  }
  return (row as Record<string, unknown>)[key];
}

function sanitizeSpikeCheckMessage(error: unknown): string {
  const message = error instanceof Error && error.message.trim() ? error.message : String(error);
  return message
    .replace(/(^|[\s([{:=])\/(?!\/)(?:[^/\s'"]+\/)+[^\s'"]+/g, '$1<path>')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
}
