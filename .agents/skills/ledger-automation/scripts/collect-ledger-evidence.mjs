#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const MIGRATIONS_ROOT = 'packages/db/src/migrations';
const INDEX_PATH = `${MIGRATIONS_ROOT}/index.ts`;
const DRIZZLE_PATH = 'packages/db/src/drizzle/migrate.ts';
const LANE_MANIFEST_PATH = 'packages/db/scripts/db-test-lane-manifest.mjs';
const RUNTIME_BASELINE_PATH = 'packages/db/src/architecture/db-runtime-baseline.ts';
const FACTORY_RESET_PATHS = [
  'packages/preferences/src/settings/system/factory-reset-helpers.ts',
  'packages/db/src/db-provider.tsx',
  'apps/desktop/src/db-main.ts',
];
const DB_TEST_ROOT = 'packages/db/__tests__/';

function fail(message) {
  process.stderr.write(`collect-ledger-evidence: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { pretty: false, revision: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node collect-ledger-evidence.mjs --repo <path> --watermark <main-sha> [--revision <revision>] [--pretty]\n'
      );
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (!['--repo', '--watermark', '--revision'].includes(argument)) {
      fail(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.repo) {
    fail('--repo is required');
  }
  if (!options.watermark) {
    fail('--watermark is required; establish the first-run range before collection');
  }
  return options;
}

function run(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function readRevisionFile(repo, revision, path) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${revision}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${path} at ${revision}: ${detail}`);
  }
}

function listRevisionFiles(repo, revision, prefix) {
  return run(repo, ['ls-tree', '-r', '--name-only', revision, '--', prefix])
    .split('\n')
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function parseNameStatus(raw) {
  if (!raw) {
    return [];
  }
  return raw.split('\n').map((line) => {
    const fields = line.split('\t');
    const status = fields[0];
    if (!status) {
      fail(`unparseable git diff entry: ${line}`);
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      if (fields.length !== 3) {
        fail(`unparseable rename/copy entry: ${line}`);
      }
      return { oldPath: fields[1], path: fields[2], status };
    }
    if (fields.length !== 2) {
      fail(`unparseable git diff entry: ${line}`);
    }
    return { path: fields[1], status };
  });
}

function migrationNumber(path) {
  const match = new RegExp(`^${MIGRATIONS_ROOT}/(\\d{3})-[^/]+\\.ts$`).exec(path);
  return match?.[1] ?? null;
}

function parseMigrationExport(path, text) {
  const number = migrationNumber(path);
  if (!number) {
    fail(`not a numbered migration path: ${path}`);
  }
  const exports = [...text.matchAll(/export const (migration\d{3}[A-Za-z0-9_]*)\s*:/g)].map(
    (match) => match[1]
  );
  if (exports.length !== 1) {
    fail(`${path} must export exactly one migration constant; found ${exports.length}`);
  }
  if (!exports[0].startsWith(`migration${number}`)) {
    fail(`${path} export ${exports[0]} does not match migration number ${number}`);
  }
  return exports[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsImport(text, symbol, modulePath) {
  const expression = new RegExp(
    `import\\s*\\{[^}]*\\b${escapeRegExp(symbol)}\\b[^}]*\\}\\s*from\\s*['"]${escapeRegExp(modulePath.replace(/\.ts$/, '.js'))}['"]`
  );
  return expression.test(text);
}

function migrationArray(text, declaration) {
  const start = text.indexOf(declaration);
  if (start === -1) {
    fail(`cannot locate ${declaration}`);
  }
  const open = text.indexOf('[', start);
  const close = text.indexOf('];', open);
  if (open === -1 || close === -1) {
    fail(`cannot parse ${declaration}`);
  }
  return [...text.slice(open + 1, close).matchAll(/\b(migration(\d{3})[A-Za-z0-9_]*)\b/g)].map(
    (match) => ({ number: Number(match[2]), symbol: match[1] })
  );
}

function customMigrationArray(text) {
  const start = text.indexOf('const customMigrations');
  if (start === -1) {
    fail('cannot locate customMigrations');
  }
  const open = text.indexOf('[', start);
  const close = text.indexOf('];', open);
  if (open === -1 || close === -1) {
    fail('cannot parse customMigrations');
  }
  return [
    ...text
      .slice(open + 1, close)
      .matchAll(/customMigration\(\s*['"]([^'"]+)['"]\s*,\s*(migration(\d{3})[A-Za-z0-9_]*)\s*\)/g),
  ].map((match) => ({ hash: match[1], number: Number(match[3]), symbol: match[2] }));
}

function orderProblems(entries, label) {
  const problems = [];
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].number >= entries[index].number) {
      problems.push({
        current: entries[index],
        previous: entries[index - 1],
        runner: label,
      });
    }
  }
  return problems;
}

function extractDdl(text) {
  const statements = [];
  const expression =
    /\b(CREATE|ALTER|DROP)\s+(?:TABLE|TYPE|INDEX)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:["']?([A-Za-z_][A-Za-z0-9_]*)["']?)/gi;
  for (const match of text.matchAll(expression)) {
    statements.push({
      keyword: match[1].toUpperCase(),
      object: match[2] ?? null,
      statement: match[0],
    });
  }
  return statements;
}

function semanticSignals(text) {
  const signals = [];
  const patterns = [
    ['catalog-upsert', /\bON\s+CONFLICT\b/i],
    ['destructive-statement', /\b(?:DROP|TRUNCATE|DELETE)\b/i],
  ];
  const lines = text.split(/\r?\n/);
  for (const [kind, expression] of patterns) {
    lines.forEach((line, offset) => {
      if (expression.test(line)) {
        signals.push({ kind, line: offset + 1, text: line.trim() });
      }
    });
  }
  return signals;
}

function parseManifestRegexes(text) {
  const regexes = [];
  text.split(/\r?\n/).forEach((line, offset) => {
    const match = line.trim().match(/^\/((?:\\.|[^/])+)\/([a-z]*),?$/i);
    if (!match) {
      return;
    }
    try {
      regexes.push({
        line: offset + 1,
        regex: new RegExp(match[1], match[2]),
        source: `/${match[1]}/${match[2]}`,
      });
    } catch (error) {
      fail(
        `invalid lane-manifest regex at line ${offset + 1}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
  if (!regexes.length) {
    fail('no DB test-lane regexes could be parsed');
  }
  return regexes;
}

function resetReferences(repo, revision, table) {
  return FACTORY_RESET_PATHS.flatMap((path) => {
    const fileList = listRevisionFiles(repo, revision, path);
    if (!fileList.includes(path)) {
      return [];
    }
    return readRevisionFile(repo, revision, path)
      .split(/\r?\n/)
      .flatMap((line, offset) =>
        line.includes(table) ? [{ line: offset + 1, path, text: line.trim() }] : []
      );
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const requestedRepo = resolve(options.repo);
  if (!existsSync(requestedRepo)) {
    fail(`repository does not exist: ${requestedRepo}`);
  }
  const repo = realpathSync(requestedRepo);
  if (!isAbsolute(repo)) {
    fail('resolved repository path is not absolute');
  }
  if (run(repo, ['rev-parse', '--show-toplevel']) !== repo) {
    fail('--repo must be the Git worktree root');
  }

  const revision = run(repo, ['rev-parse', options.revision]);
  const watermark = run(repo, ['rev-parse', options.watermark]);
  if (watermark === revision) {
    const result = {
      analysisComplete: true,
      generatedAt: new Date().toISOString(),
      mechanicalGaps: [],
      migrationDelta: [],
      noMigrationDelta: true,
      repo,
      revision,
      schemaVersion: 1,
      semanticReviewCandidates: [],
      watermark,
    };
    process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
    return;
  }
  run(repo, ['merge-base', '--is-ancestor', watermark, revision]);

  const changes = parseNameStatus(
    run(repo, [
      'diff',
      '--find-renames',
      '--name-status',
      `${watermark}..${revision}`,
      '--',
      MIGRATIONS_ROOT,
      'packages/db/__tests__',
      LANE_MANIFEST_PATH,
      RUNTIME_BASELINE_PATH,
    ])
  );
  const migrationChanges = changes.filter((change) => migrationNumber(change.path));
  const newDbTests = changes
    .filter(
      (change) =>
        change.status.startsWith('A') &&
        change.path.startsWith(DB_TEST_ROOT) &&
        /\.test\.(?:ts|tsx)$/.test(change.path)
    )
    .map((change) => change.path.slice(DB_TEST_ROOT.length));

  const indexText = readRevisionFile(repo, revision, INDEX_PATH);
  const drizzleText = readRevisionFile(repo, revision, DRIZZLE_PATH);
  const manifestText = readRevisionFile(repo, revision, LANE_MANIFEST_PATH);
  const indexEntries = migrationArray(indexText, 'export const migrations');
  const customEntries = customMigrationArray(drizzleText);
  const indexOrderProblems = orderProblems(indexEntries, 'numbered-runner');
  const drizzleOrderProblems = orderProblems(customEntries, 'drizzle-customMigrations');
  const laneRegexes = parseManifestRegexes(manifestText);

  const migrationDelta = migrationChanges.map((change) => {
    const text = readRevisionFile(repo, revision, change.path);
    const symbol = parseMigrationExport(change.path, text);
    const number = Number(migrationNumber(change.path));
    const drizzleEntry = customEntries.find((entry) => entry.symbol === symbol);
    return {
      change,
      drizzle: {
        customEntry: drizzleEntry ?? null,
        importPresent: containsImport(
          drizzleText,
          symbol,
          `../migrations/${change.path.slice(`${MIGRATIONS_ROOT}/`.length)}`
        ),
        registered: Boolean(drizzleEntry),
      },
      number,
      numberedRunner: {
        importPresent: containsImport(
          indexText,
          symbol,
          `./${change.path.slice(`${MIGRATIONS_ROOT}/`.length)}`
        ),
        registered: indexEntries.some((entry) => entry.symbol === symbol),
      },
      schemaShape: extractDdl(text),
      semanticSignals: semanticSignals(text),
      symbol,
    };
  });

  const mechanicalGaps = migrationDelta.flatMap((migration) => {
    const gaps = [];
    if (!migration.numberedRunner.importPresent) {
      gaps.push({
        kind: 'missing-numbered-runner-import',
        migration: migration.number,
        path: migration.change.path,
      });
    }
    if (!migration.numberedRunner.registered) {
      gaps.push({
        kind: 'missing-numbered-runner-registration',
        migration: migration.number,
        path: migration.change.path,
      });
    }
    if (!migration.drizzle.importPresent) {
      gaps.push({
        kind: 'missing-drizzle-import',
        migration: migration.number,
        path: migration.change.path,
      });
    }
    if (!migration.drizzle.registered) {
      gaps.push({
        kind: 'missing-drizzle-custom-migration',
        migration: migration.number,
        path: migration.change.path,
      });
    }
    return gaps;
  });
  for (const problem of [...indexOrderProblems, ...drizzleOrderProblems]) {
    mechanicalGaps.push({ kind: 'ordering-anomaly', ...problem });
  }

  const testLaneAssignments = newDbTests.map((path) => {
    const matches = laneRegexes.filter((entry) => entry.regex.test(path));
    return {
      matches: matches.map((entry) => ({ line: entry.line, source: entry.source })),
      path,
      status: matches.length === 1 ? 'assigned' : matches.length === 0 ? 'unassigned' : 'ambiguous',
    };
  });
  for (const assignment of testLaneAssignments.filter(
    (assignment) => assignment.status !== 'assigned'
  )) {
    mechanicalGaps.push({
      kind: `db-test-lane-${assignment.status}`,
      matches: assignment.matches,
      path: assignment.path,
    });
  }

  const newTables = migrationDelta.flatMap((migration) =>
    migration.schemaShape
      .filter(
        (shape) => shape.keyword === 'CREATE' && shape.statement.toUpperCase().includes('TABLE')
      )
      .flatMap((shape) =>
        shape.object
          ? [
              {
                migration: migration.number,
                resetReferences: resetReferences(repo, revision, shape.object),
                table: shape.object,
              },
            ]
          : []
      )
  );
  const semanticReviewCandidates = migrationDelta.flatMap((migration) =>
    migration.semanticSignals.map((signal) => ({
      migration: migration.number,
      path: migration.change.path,
      ...signal,
    }))
  );
  if (indexOrderProblems.length || drizzleOrderProblems.length) {
    semanticReviewCandidates.push({
      kind: 'ordering-anomaly',
      text: 'Runner ledger ordering is not strictly ascending; inspect before editing.',
    });
  }

  const result = {
    analysisComplete: true,
    factoryResetReview: newTables,
    generatedAt: new Date().toISOString(),
    mechanicalGaps,
    migrationDelta,
    noMigrationDelta: migrationDelta.length === 0,
    repo,
    revision,
    runtimeBaselineReview: {
      changed: changes.some((change) => change.path === RUNTIME_BASELINE_PATH),
      path: RUNTIME_BASELINE_PATH,
      requiredManualReview: migrationDelta.some((migration) => migration.schemaShape.length > 0),
    },
    schemaVersion: 1,
    semanticReviewCandidates,
    testLaneAssignments,
    watermark,
  };
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
}

main();
