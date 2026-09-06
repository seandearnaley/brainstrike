#!/usr/bin/env node
/**
 * Generate the DB seed migration for models that `provider-catalog.json`
 * declares and the DB model catalog does not yet have (BST-1650).
 *
 * The catalog and the `models` table have been hand-mirrored since migration
 * 015, with `scripts/model-catalog-migration-contract.mjs` as the tripwire.
 * Now that the catalog is data, the ADD half of that mirroring is mechanical
 * and this script does it — from the same final-catalog snapshot the contract
 * checker builds, so the two can never disagree about what is missing.
 *
 * Deliberately narrow:
 *
 * - ADD-ONLY. A catalog row that DISAPPEARED needs `MODEL_ID_MIGRATIONS` and
 *   `MEMORY_MODEL_TARGET_MIGRATIONS` decisions and a user-visible remap notice
 *   (BST-565). Those are judgement calls, so a pending removal is reported as
 *   a hard error instead of being generated.
 * - Only columns the catalog actually carries are emitted. `tagline` and
 *   `best_for` feed the db-explorer from their OWN source (database.md rule 7)
 *   and are left NULL for a human to author — never invented from the
 *   registry's composer copy.
 * - `sort_order` appends, computed in SQL at apply time, so the migration is
 *   correct against whatever rows a given profile already holds.
 * - The upsert preserves the user's toggle with `is_enabled = models.is_enabled`.
 *   Using `EXCLUDED.is_enabled` would clobber it (database.md rule 3).
 *
 * Usage:
 *   node scripts/gen-model-catalog-migration.mjs           # print the plan
 *   node scripts/gen-model-catalog-migration.mjs --write   # write the files
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildFinalCatalogSnapshot,
  CATALOG_FILE,
  readMigrationFiles,
  summarizeMigrationFile,
} from './model-catalog-migration-contract.mjs';

const MIGRATIONS_DIR = 'packages/db/src/migrations';
const MIGRATION_INDEX = `${MIGRATIONS_DIR}/index.ts`;

function modelKey(row) {
  return `${row.providerId}::${row.id}`;
}

function toKebabCase(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toSnakeCase(value) {
  return toKebabCase(value).replace(/-/g, '_');
}

function toPascalCase(value) {
  return toKebabCase(value)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function quoteSqlString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build the `capabilities` jsonb for one catalog row. Every field comes from
 * the catalog; nothing is defaulted. A model the catalog cannot describe
 * completely is REFUSED rather than written with a guessed capability — an
 * LLM row without `vision` fails `frontier-models-migration.test.ts`, and a
 * wrong one silently mis-gates the composer's attachment affordance.
 */
function buildCapabilities(providerId, model) {
  if (model.type === 'llm') {
    if (typeof model.supportsStreaming !== 'boolean') {
      throw new Error(
        `${modelKey({ id: model.id, providerId })} must declare supportsStreaming before a migration can be generated.`
      );
    }
    if (model.vision !== 'supported' && model.vision !== 'unsupported') {
      throw new Error(
        `${modelKey({ id: model.id, providerId })} must declare vision as 'supported' or 'unsupported' before a migration can be generated.`
      );
    }
    return {
      streaming: model.supportsStreaming,
      type: 'llm',
      vision: model.vision === 'supported',
    };
  }

  if (typeof model.defaultDimension !== 'number') {
    throw new Error(
      `${modelKey({ id: model.id, providerId })} must declare defaultDimension before a migration can be generated.`
    );
  }
  return { defaultDimension: model.defaultDimension, type: 'embedding' };
}

function collectCatalogRows(catalog) {
  const rows = [];
  for (const provider of catalog) {
    for (const model of provider.models) {
      rows.push({
        capabilities: buildCapabilities(provider.id, model),
        id: model.id,
        name: model.label ?? model.id,
        providerId: provider.id,
        type: model.type,
      });
    }
  }
  return rows;
}

function renderValuesRow(row, sortOrderOffset) {
  const sortOrder =
    '(SELECT COALESCE(MAX(sort_order), 0) FROM models WHERE provider_id = ' +
    `${quoteSqlString(row.providerId)}) + ${sortOrderOffset}`;
  return [
    '      (',
    `        ${quoteSqlString(row.id)},`,
    `        ${quoteSqlString(row.providerId)},`,
    `        ${quoteSqlString(row.name)},`,
    `        ${quoteSqlString(JSON.stringify(row.capabilities))},`,
    `        ${sortOrder},`,
    '        false',
    '      )',
  ].join('\n');
}

function renderUpSql(additions) {
  const offsets = new Map();
  const values = additions.map((row) => {
    const offset = (offsets.get(row.providerId) ?? 0) + 1;
    offsets.set(row.providerId, offset);
    return renderValuesRow(row, offset);
  });

  return [
    '',
    '    INSERT INTO models',
    '      (id, provider_id, name, capabilities, sort_order, is_enabled)',
    '    VALUES',
    `${values.join(',\n')}`,
    '    ON CONFLICT (id) DO UPDATE SET',
    '      provider_id = EXCLUDED.provider_id,',
    '      name = EXCLUDED.name,',
    '      capabilities = EXCLUDED.capabilities,',
    '      sort_order = EXCLUDED.sort_order,',
    '      is_enabled = models.is_enabled;',
    '  ',
  ].join('\n');
}

function renderDownSql(additions) {
  const ids = additions.map((row) => quoteSqlString(row.id)).join(', ');
  return ['', `    DELETE FROM models WHERE id IN (${ids});`, '  '].join('\n');
}

function renderMigrationSource({ additions, exportName, ledgerKey, name, version }) {
  const summary = additions.map((row) => `${row.providerId}/${row.id}`).join(', ');
  return `import type { Migration } from './migration-runner.js';

// Generated by scripts/gen-model-catalog-migration.mjs from
// ${CATALOG_FILE}.
// Adds: ${summary}.
// \`tagline\` and \`best_for\` are intentionally NULL — they are db-explorer copy
// with their own source, not a mirror of the registry's composer tagline.
/** Mirror the static registry entries added to the provider catalog. */
export const ${exportName}: Migration = {
  down: \`${renderDownSql(additions)}\`,
  ledgerKey: '${ledgerKey}',
  name: '${name}',
  up: \`${renderUpSql(additions)}\`,
  version: ${version},
};
`;
}

function nextMigrationVersion(migrationFiles) {
  let highest = 0;
  for (const file of migrationFiles) {
    const match = path.basename(file.file).match(/^(\d{3})-/);
    if (match) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  if (highest === 0) {
    throw new Error('No numbered migrations found; refusing to guess a version number.');
  }
  return highest + 1;
}

function addImportLine(indexSource, exportName, fileBaseName) {
  const importLine = `import { ${exportName} } from './${fileBaseName}.js';\n`;
  const imports = [...indexSource.matchAll(/^import \{ migration\d{3}[^\n]*\n/gm)];
  const lastImport = imports.at(-1);
  if (!lastImport) {
    throw new Error(`${MIGRATION_INDEX} has no numbered migration imports to append after.`);
  }
  const insertAt = lastImport.index + lastImport[0].length;
  return indexSource.slice(0, insertAt) + importLine + indexSource.slice(insertAt);
}

function addManifestEntry(indexSource, exportName) {
  // BST-1643: the numbered array is the single manifest; the Drizzle ledger is
  // derived from it, so registering here is the ONLY registration needed.
  const marker = '\n];\n';
  const anchor = indexSource.indexOf(marker);
  if (anchor < 0) {
    throw new Error(`${MIGRATION_INDEX} has no migrations array terminator to append before.`);
  }
  return `${indexSource.slice(0, anchor)}\n  ${exportName},${indexSource.slice(anchor)}`;
}

/**
 * Pure planner: no filesystem writes, so the tests exercise exactly what the
 * CLI writes.
 */
export function planModelCatalogMigration({
  migrationFiles,
  migrationIndexSource,
  providerCatalog,
}) {
  const snapshot = buildFinalCatalogSnapshot(migrationFiles.map(summarizeMigrationFile));
  const catalogRows = collectCatalogRows(providerCatalog);
  const catalogKeys = new Set(catalogRows.map(modelKey));

  // Scope removals to providers the catalog still declares, exactly as
  // `findStaticProviderRegistryFailures` does. The snapshot is a static
  // reconstruction from migration SQL and does not model provider RENAMES
  // (migration 021 moved `transformers` rows to `local` with an UPDATE), so
  // rows under a retired provider id are reconstruction residue, not a
  // pending catalog deletion.
  const catalogProviderIds = new Set(providerCatalog.map((provider) => provider.id));
  const removals = [...snapshot.values()].filter(
    (row) => catalogProviderIds.has(row.providerId) && !catalogKeys.has(modelKey(row))
  );
  if (removals.length > 0) {
    throw new Error(
      'This generator is add-only. These DB catalog rows are no longer in the catalog and need ' +
        'MODEL_ID_MIGRATIONS + MEMORY_MODEL_TARGET_MIGRATIONS remap decisions first (BST-565):\n' +
        removals.map((row) => `  - ${modelKey(row)}`).join('\n')
    );
  }

  const additions = catalogRows.filter((row) => {
    const existing = snapshot.get(row.id);
    return !(existing && existing.providerId === row.providerId && existing.type === row.type);
  });
  if (additions.length === 0) {
    return { additions: [], migration: null };
  }

  const version = nextMigrationVersion(migrationFiles);
  const providerIds = [...new Set(additions.map((row) => row.providerId))];
  const slugSource =
    additions.length === 1
      ? `${additions[0].providerId} ${additions[0].id}`
      : `${providerIds.join(' ')} catalog models`;
  const slug = toKebabCase(slugSource);
  const paddedVersion = String(version).padStart(3, '0');
  const fileBaseName = `${paddedVersion}-${slug}`;
  const exportName = `migration${paddedVersion}${toPascalCase(slugSource)}`;
  const name = toSnakeCase(slugSource);

  return {
    additions,
    migration: {
      exportName,
      file: `${MIGRATIONS_DIR}/${fileBaseName}.ts`,
      indexSource: addManifestEntry(
        addImportLine(migrationIndexSource, exportName, fileBaseName),
        exportName
      ),
      ledgerKey: `custom-${paddedVersion}-${slug}`,
      name,
      source: renderMigrationSource({
        additions,
        exportName,
        ledgerKey: `custom-${paddedVersion}-${slug}`,
        name,
        version,
      }),
      version,
    },
  };
}

async function main() {
  const rootDir = process.cwd();
  const shouldWrite = process.argv.includes('--write');
  const [migrationFiles, migrationIndexSource, catalogSource] = await Promise.all([
    readMigrationFiles(rootDir),
    readFile(path.join(rootDir, MIGRATION_INDEX), 'utf8'),
    readFile(path.join(rootDir, CATALOG_FILE), 'utf8'),
  ]);

  const plan = planModelCatalogMigration({
    migrationFiles,
    migrationIndexSource,
    providerCatalog: JSON.parse(catalogSource),
  });

  if (!plan.migration) {
    console.log('The DB model catalog already covers every provider-catalog.json row.');
    return;
  }

  console.log(
    `${plan.additions.length} catalog row(s) missing from the DB model catalog:\n` +
      plan.additions.map((row) => `  - ${row.providerId}/${row.id} (${row.type})`).join('\n')
  );

  if (!shouldWrite) {
    console.log(`\n--- ${plan.migration.file} (dry run; pass --write to apply) ---\n`);
    console.log(plan.migration.source);
    return;
  }

  await writeFile(path.join(rootDir, plan.migration.file), plan.migration.source, {
    flag: 'wx',
  });
  await writeFile(path.join(rootDir, MIGRATION_INDEX), plan.migration.indexSource);
  console.log(
    `\nWrote ${plan.migration.file} and registered ${plan.migration.exportName} in ${MIGRATION_INDEX}.\n` +
      'Review tagline/best_for/sort_order before committing, then run ' +
      'node scripts/model-catalog-migration-contract.mjs.'
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
