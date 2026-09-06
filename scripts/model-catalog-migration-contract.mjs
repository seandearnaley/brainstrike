#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { parseTypeScriptSource } from './provider-registry-ast-helpers.mjs';

const MIGRATION_EXPORT_PATTERN =
  /export\s+const\s+(migration\d{3}[A-Za-z0-9_]*)\s*:\s*Migration\s*=/;
// Keep this literal table list in sync with the model catalog schema. The check
// intentionally scans whole migration files, including down blocks/comments, so
// ambiguous catalog mentions fail closed instead of silently bypassing ledger checks.
const CATALOG_ROW_MUTATION_PATTERN =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:models|providers)"?\b/i;
const ASSISTANT_MODEL_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'local',
]);
const OBSERVATIONAL_MEMORY_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'openrouter']);
// The removed-model remap contract was introduced with the 2026 frontier
// catalog refresh. Earlier migrations are historical input used to reconstruct
// the catalog snapshot; future deletions from this version onward are enforced.
const REMOVED_MODEL_REMAP_CONTRACT_START_VERSION = 33;
// Module-level MUTABLE state, and `gen-model-catalog-migration.test.mjs` adds
// to it under try/finally because an empty allowlist has no other way to
// exercise its own wiring. The BST-1650 follow-up weighed that against making
// the residue predicate injectable into `planModelCatalogMigration`, and the
// try/finally WINS — do not "fix" it into a parameter:
//
//   The property under test is that the generator and the contract checker
//   consult the SAME allowlist. A planner that accepted its own residue
//   predicate could be proved green against a rule the checker never sees,
//   which is the exact divergence `isHistoricalCatalogResidue` was extracted to
//   make impossible and that `docs/agents/database.md` states as a contract. A
//   seam that lets a test fake the coupling it is asserting is worse than the
//   mutation it replaces — and it would add a parameter no production call site
//   ever passes.
//
// `node --test` runs a file's tests sequentially, and the finally restores the
// Set, so the blast radius is the one test that opts in.
export const STATIC_CATALOG_STALE_ROW_ALLOWLIST = new Set([]);
// Providers whose final-snapshot rows are RECONSTRUCTION RESIDUE rather than a
// pending catalog deletion. Migration 021 renamed `transformers` to `local`
// with `UPDATE models SET provider_id = ...`, and the operation extractor
// models only INSERT/DELETE, so every pre-021 row survives in the snapshot
// under a provider id no catalog has declared since.
//
// This list is CLOSED. Any OTHER provider vanishing from the catalog is a real
// deletion that owes a catalog migration plus MODEL_ID_MIGRATIONS /
// MEMORY_MODEL_TARGET_MIGRATIONS decisions (BST-565); exempting it because its
// id is simply absent would leave stale DB rows behind while persisted user
// selections dangle.
export const RETIRED_PROVIDER_RESIDUE_IDS = new Set(['transformers']);

function extractMigrationExportName(source) {
  return source.match(MIGRATION_EXPORT_PATTERN)?.[1] ?? null;
}

function extractMigrationArrayNames(source) {
  const match = source.match(/export\s+const\s+migrations\b[^=]*=\s*\[([\s\S]*?)\];/);
  if (!match) {
    return new Set();
  }

  return new Set(match[1].match(/\bmigration\d{3}[A-Za-z0-9_]*\b/g) ?? []);
}

function getPropertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function findConstObjectLiteral(source, constName, fileName) {
  const sourceFile = parseTypeScriptSource(source, fileName);
  let initializer = null;

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === constName &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      initializer = node.initializer;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return initializer;
}

function stringLiteralInitializerValue(node) {
  const value = unwrapExpression(node);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text;
  }
  return null;
}

function unwrapExpression(node) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return unwrapExpression(node.expression);
  }
  return node;
}

function extractStringRecord(source, constName, fileName) {
  const initializer = findConstObjectLiteral(source, constName, fileName);
  const record = new Map();
  if (!initializer) {
    return record;
  }

  for (const property of initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const key = getPropertyNameText(property.name);
    const value = stringLiteralInitializerValue(property.initializer);
    if (key && value) {
      record.set(key, value);
    }
  }

  return record;
}

function extractNestedStringRecord(source, constName, fileName) {
  const initializer = findConstObjectLiteral(source, constName, fileName);
  const record = new Map();
  if (!initializer) {
    return record;
  }

  for (const property of initializer.properties) {
    if (
      !(ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer))
    ) {
      continue;
    }

    const provider = getPropertyNameText(property.name);
    if (!provider) {
      continue;
    }

    const providerRecord = new Map();
    for (const nestedProperty of property.initializer.properties) {
      if (!ts.isPropertyAssignment(nestedProperty)) {
        continue;
      }

      const key = getPropertyNameText(nestedProperty.name);
      const value = stringLiteralInitializerValue(nestedProperty.initializer);
      if (key && value) {
        providerRecord.set(key, value);
      }
    }
    record.set(provider, providerRecord);
  }

  return record;
}

function extractMigrationUpSql(file) {
  const sourceFile = parseTypeScriptSource(file.source, file.file);
  let upSql = '';

  function visit(node) {
    if (!ts.isPropertyAssignment(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const propertyName = getPropertyNameText(node.name);
    if (propertyName !== 'up') {
      ts.forEachChild(node, visit);
      return;
    }

    const value = stringLiteralInitializerValue(node.initializer);
    if (value !== null) {
      upSql = value;
    }
  }

  visit(sourceFile);
  return upSql;
}

export const CATALOG_FILE = 'packages/assistant-contract/src/provider-catalog.json';

/**
 * `provider-catalog.json` already declares every object's keys in ascending
 * order, at every depth, with no exception in the whole file. That property is
 * what makes BST-1650's promise hold — catalog edits read as data diffs — and
 * it is the file the team edits weekly: two model rows line up field for
 * field, and a field added by one author cannot land in a different slot than
 * the same field on the row below.
 *
 * NOTHING enforced it. `biome.json` re-includes this one path from the blanket
 * `!**\/*.json` so the file is FORMATTED, but Biome's `useSortedKeys` assist
 * does not reach JSON object keys — unsorting a row and running
 * `biome check packages/assistant-contract/src/provider-catalog.json` reports
 * nothing. So the check lives here, in the contract CI already runs as
 * `pnpm lint:model-catalog-migrations`.
 *
 * Two deliberate limits:
 *
 * - ROW order is NOT checked. The catalog lists `gpt-5.6-sol` before
 *   `gpt-5.6-terra` and `claude-opus-5` before `claude-sonnet-5`: curated
 *   editorial order that no comparator derives. Inventing a row rule would
 *   churn the file this check exists to keep quiet.
 * - Nothing is auto-fixed. A silent reorder of a data file is an invisible
 *   change to the very rows a reviewer is reading, so a wrong order FAILS and
 *   names the entry to reorder.
 */
function compareCatalogKeys(left, right) {
  // Code-unit order, which is exactly what `Object.keys(...).sort()` yields, so
  // the rule reads the same on every machine. `localeCompare` would make the
  // check locale-dependent and would not agree with the file about `_note`.
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function catalogArraySegment(entry, index) {
  const id = isPlainObject(entry) && typeof entry.id === 'string' ? entry.id : null;
  return id ?? `[${index}]`;
}

function describeCatalogPath(path) {
  return path.length > 0 ? path.join('.') : 'the provider catalog root';
}

function visitCatalogObjects(value, path, visit) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitCatalogObjects(entry, [...path, catalogArraySegment(entry, index)], visit);
    });
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  visit(value, path);
  for (const [key, nested] of Object.entries(value)) {
    visitCatalogObjects(nested, [...path, key], visit);
  }
}

/**
 * Report the FIRST out-of-order key of each catalog object. One failure per
 * object, not one per disturbed pair: a reviewer needs the key to move, and a
 * shuffled row would otherwise bury the other failures under its own noise.
 */
export function findCatalogKeyOrderFailures(catalog) {
  const failures = [];

  visitCatalogObjects(catalog, [], (entry, path) => {
    const keys = Object.keys(entry);
    for (let index = 1; index < keys.length; index += 1) {
      const previous = keys[index - 1];
      const current = keys[index];
      if (compareCatalogKeys(previous, current) <= 0) {
        continue;
      }

      failures.push({
        file: CATALOG_FILE,
        message: `Catalog entry ${describeCatalogPath(path)} declares "${current}" after "${previous}"; provider-catalog.json object keys are alphabetical at every depth so catalog edits stay reviewable data diffs. Reorder this entry's keys.`,
      });
      return;
    }
  });

  return failures;
}

/**
 * Read the static catalog rows from `provider-catalog.json` (BST-1650). This
 * used to walk the TypeScript AST of `provider-registry.ts` and resolve
 * identifier-valued fields against exported string constants; the catalog is
 * data now, so the walk is a plain traversal and the "unresolvable expression"
 * failure class no longer exists.
 *
 * Structural problems still fail CLOSED — a catalog this function cannot read
 * must never be reported as an empty catalog, which would silently pass every
 * downstream comparison.
 */
export function readProviderCatalogModels(catalog) {
  const failures = [];
  const rows = [];
  const claimedModelKeys = new Set();

  if (!Array.isArray(catalog)) {
    failures.push({
      file: CATALOG_FILE,
      message: 'The provider catalog must be a JSON array of provider objects.',
    });
    return { claimedModelKeys, failures, rows };
  }

  for (const provider of catalog) {
    if (!isPlainObject(provider)) {
      failures.push({ file: CATALOG_FILE, message: 'Provider catalog entries must be objects.' });
      continue;
    }

    const providerId = provider.id;
    if (typeof providerId !== 'string') {
      failures.push({
        file: CATALOG_FILE,
        message: 'Provider catalog entry is missing a string id.',
      });
      continue;
    }

    if (!Array.isArray(provider.models)) {
      failures.push({
        file: CATALOG_FILE,
        message: `Provider ${providerId} must declare a models array.`,
      });
      continue;
    }

    for (const model of provider.models) {
      if (!isPlainObject(model)) {
        failures.push({
          file: CATALOG_FILE,
          message: `Model entries for ${providerId} must be objects.`,
        });
        continue;
      }

      const id = typeof model.id === 'string' ? model.id : null;
      const type = typeof model.type === 'string' ? model.type : null;
      if (!id) {
        failures.push({
          file: CATALOG_FILE,
          message: `A model entry for ${providerId} is missing a string id.`,
        });
      }
      if (id) {
        claimedModelKeys.add(modelKey({ id, providerId }));
      }
      if (!type) {
        failures.push({
          file: CATALOG_FILE,
          message: id
            ? `Catalog model ${modelKey({ id, providerId })} is missing a string type.`
            : `A model entry for ${providerId} is missing a string type.`,
        });
      }
      if (id && type) {
        rows.push({ id, providerId, type });
      }
    }
  }

  return { claimedModelKeys, failures, rows };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summarizeMigrationFile(file) {
  const exportName = extractMigrationExportName(file.source);
  const upSql = extractMigrationUpSql(file);
  return {
    catalogMutating: CATALOG_ROW_MUTATION_PATTERN.test(upSql),
    exportName,
    file: file.file,
    operations: extractModelCatalogOperations(upSql),
  };
}

function stripSqlIdentifier(value) {
  const trimmed = value.trim();
  return trimmed.replace(/^"|"$/g, '');
}

function readSqlStringLiteral(sql, startIndex) {
  if (sql[startIndex] !== "'") {
    return null;
  }

  let value = '';
  let index = startIndex + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (char !== "'") {
      value += char;
      index += 1;
      continue;
    }

    if (sql[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }

    return { endIndex: index + 1, value };
  }

  return null;
}

function extractSqlStringLiterals(sql) {
  const values = [];
  let index = 0;
  while (index < sql.length) {
    if (sql[index] !== "'") {
      index += 1;
      continue;
    }

    const parsed = readSqlStringLiteral(sql, index);
    if (!parsed) {
      break;
    }

    values.push(parsed.value);
    index = parsed.endIndex;
  }
  return values;
}

function splitTopLevelCommaValues(valueSource) {
  const values = [];
  let start = 0;
  let depth = 0;
  let index = 0;

  while (index < valueSource.length) {
    if (valueSource[index] === "'") {
      const parsed = readSqlStringLiteral(valueSource, index);
      index = parsed ? parsed.endIndex : valueSource.length;
      continue;
    }

    if (valueSource[index] === '(') {
      depth += 1;
    } else if (valueSource[index] === ')') {
      depth -= 1;
    } else if (valueSource[index] === ',' && depth === 0) {
      values.push(valueSource.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }

  const finalValue = valueSource.slice(start).trim();
  if (finalValue) {
    values.push(finalValue);
  }

  return values;
}

function extractTopLevelParenthesizedBlocks(source, startIndex) {
  const blocks = [];
  let depth = 0;
  let blockStart = null;
  let index = startIndex;

  while (index < source.length) {
    if (source[index] === "'") {
      const parsed = readSqlStringLiteral(source, index);
      index = parsed ? parsed.endIndex : source.length;
      continue;
    }

    if (source[index] === ';' && depth === 0) {
      break;
    }

    if (depth === 0 && /^ON\s+CONFLICT\b/i.test(source.slice(index))) {
      break;
    }

    if (source[index] === '(') {
      if (depth === 0) {
        blockStart = index + 1;
      }
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0 && blockStart !== null) {
        blocks.push(source.slice(blockStart, index));
        blockStart = null;
      }
    }

    index += 1;
  }

  return blocks;
}

function parseCapabilitiesType(value) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed.type === 'string' ? parsed.type : null;
  } catch {
    const match = value.match(/"type"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  }
}

function extractInsertedModelRows(sql) {
  const rows = [];
  const insertPattern = /INSERT\s+INTO\s+"?models"?\s*\(([\s\S]*?)\)\s*VALUES\b/gi;
  for (const match of sql.matchAll(insertPattern)) {
    const columns = match[1].split(',').map(stripSqlIdentifier);
    const columnIndex = new Map(columns.map((column, index) => [column, index]));
    const valuesStart = match.index + match[0].length;
    const blocks = extractTopLevelParenthesizedBlocks(sql, valuesStart);

    for (const block of blocks) {
      const values = splitTopLevelCommaValues(block).map(
        (value) => extractSqlStringLiterals(value)[0]
      );
      const id = values[columnIndex.get('id')];
      const providerId = values[columnIndex.get('provider_id')];
      if (!(id && providerId)) {
        continue;
      }

      rows.push({
        id,
        providerId,
        type: parseCapabilitiesType(values[columnIndex.get('capabilities')]),
      });
    }
  }
  return rows;
}

function extractModelCatalogOperations(sql) {
  const operations = [];

  const deleteIdsPattern =
    /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bid\s+IN\s*\(([\s\S]*?)\)/gi;
  for (const match of sql.matchAll(deleteIdsPattern)) {
    operations.push({
      ids: extractSqlStringLiterals(match[1]),
      index: match.index,
      kind: 'delete-ids',
    });
  }

  const deleteIdPattern =
    /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bid\s*=\s*'((?:''|[^'])*)'/gi;
  for (const match of sql.matchAll(deleteIdPattern)) {
    operations.push({
      ids: [match[1].replaceAll("''", "'")],
      index: match.index,
      kind: 'delete-ids',
    });
  }

  const deleteProvidersPattern =
    /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bprovider_id\s+IN\s*\(([\s\S]*?)\)/gi;
  for (const match of sql.matchAll(deleteProvidersPattern)) {
    operations.push({
      index: match.index,
      kind: 'delete-providers',
      providerIds: extractSqlStringLiterals(match[1]),
    });
  }

  const deleteProviderPattern =
    /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bprovider_id\s*=\s*'((?:''|[^'])*)'/gi;
  for (const match of sql.matchAll(deleteProviderPattern)) {
    operations.push({
      index: match.index,
      kind: 'delete-providers',
      providerIds: [match[1].replaceAll("''", "'")],
    });
  }

  const insertPattern = /INSERT\s+INTO\s+"?models"?\s*\(/gi;
  for (const match of sql.matchAll(insertPattern)) {
    operations.push({
      index: match.index,
      kind: 'insert-models',
      rows: extractInsertedModelRows(sql.slice(match.index, findSqlStatementEnd(sql, match.index))),
    });
  }

  return operations.sort((left, right) => left.index - right.index);
}

function findSqlStatementEnd(sql, startIndex) {
  let index = startIndex;
  while (index < sql.length) {
    if (sql[index] === "'") {
      const parsed = readSqlStringLiteral(sql, index);
      index = parsed ? parsed.endIndex : sql.length;
      continue;
    }

    if (sql[index] === ';') {
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

function modelKey(row) {
  return `${row.providerId}::${row.id}`;
}

/**
 * Is this final-snapshot row historical residue rather than a catalog row
 * somebody deleted?
 *
 * `scripts/gen-model-catalog-migration.mjs` imports this so the checker and the
 * generator can never disagree about which rows are residue: a row one of them
 * waves through and the other treats as a pending deletion would either block
 * generation permanently or hide a removal the checker is meant to catch.
 */
export function isHistoricalCatalogResidue(row) {
  return (
    RETIRED_PROVIDER_RESIDUE_IDS.has(row.providerId) ||
    STATIC_CATALOG_STALE_ROW_ALLOWLIST.has(modelKey(row))
  );
}

function memoryModelTarget(row) {
  if (row.providerId === 'openrouter') {
    return `openrouter/${row.id}`;
  }
  return `${row.providerId}/${row.id}`;
}

function migrationFileVersion(file) {
  const match = file.match(/(?:^|[\\/])(\d{3})-/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function requiresRemovedModelRemaps(file) {
  const version = migrationFileVersion(file);
  return version === null || version >= REMOVED_MODEL_REMAP_CONTRACT_START_VERSION;
}

function rowRemainsInFinalSnapshot(row, snapshot) {
  const finalRow = snapshot.get(row.id);
  return finalRow?.providerId === row.providerId && finalRow.type === row.type;
}

function collectDeletedRowsRequiringRemaps(migrationSummaries) {
  const snapshot = new Map();
  const deletedRows = [];

  for (const migration of migrationSummaries) {
    const collectDeletes = requiresRemovedModelRemaps(migration.file);
    for (const operation of migration.operations) {
      if (operation.kind === 'delete-ids') {
        for (const id of operation.ids) {
          const existing = snapshot.get(id);
          if (collectDeletes && existing) {
            deletedRows.push(existing);
          }
          snapshot.delete(id);
        }
        continue;
      }

      if (operation.kind === 'delete-providers') {
        for (const row of snapshot.values()) {
          if (operation.providerIds.includes(row.providerId)) {
            if (collectDeletes) {
              deletedRows.push(row);
            }
            snapshot.delete(row.id);
          }
        }
        continue;
      }

      if (operation.kind === 'insert-models') {
        for (const row of operation.rows) {
          snapshot.set(row.id, row);
        }
      }
    }
  }

  return deletedRows.filter((row) => !rowRemainsInFinalSnapshot(row, snapshot));
}

export function buildFinalCatalogSnapshot(migrationSummaries) {
  const snapshot = new Map();

  for (const migration of migrationSummaries) {
    for (const operation of migration.operations) {
      if (operation.kind === 'delete-ids') {
        for (const id of operation.ids) {
          snapshot.delete(id);
        }
        continue;
      }

      if (operation.kind === 'delete-providers') {
        for (const row of [...snapshot.values()]) {
          if (operation.providerIds.includes(row.providerId)) {
            snapshot.delete(row.id);
          }
        }
        continue;
      }

      if (operation.kind === 'insert-models') {
        for (const row of operation.rows) {
          snapshot.set(row.id, row);
        }
      }
    }
  }

  return snapshot;
}

function findStaticProviderRegistryFailures(input, migrationSummaries) {
  if (input.providerCatalog === undefined) {
    return [];
  }

  const finalCatalog = buildFinalCatalogSnapshot(migrationSummaries);
  const registry = readProviderCatalogModels(input.providerCatalog);
  const failures = [...registry.failures];

  for (const row of registry.rows) {
    const catalogRow = finalCatalog.get(row.id);
    if (catalogRow?.providerId === row.providerId && catalogRow.type === row.type) {
      continue;
    }

    if (catalogRow?.providerId === row.providerId) {
      failures.push({
        file: CATALOG_FILE,
        message: `Static catalog model ${modelKey(row)} has type ${row.type}, but the final DB model catalog has type ${catalogRow.type ?? 'unknown'}.`,
      });
    } else {
      failures.push({
        file: CATALOG_FILE,
        message: `Static catalog model ${modelKey(row)} is missing from the final DB model catalog.`,
      });
    }
  }

  for (const row of finalCatalog.values()) {
    const key = modelKey(row);
    // A provider missing from the catalog entirely is NOT a reason to skip:
    // that is the whole-provider deletion case, and it owes the same migration
    // and remap decisions as a single removed row.
    if (registry.claimedModelKeys.has(key) || isHistoricalCatalogResidue(row)) {
      continue;
    }

    failures.push({
      file: CATALOG_FILE,
      message: `Final DB model catalog row ${key} is missing from ${CATALOG_FILE}; delete it in a catalog migration or add it to STATIC_CATALOG_STALE_ROW_ALLOWLIST.`,
    });
  }

  return failures;
}

function findRemovedAssistantModelRemapFailures(input, migrationSummaries) {
  if (!(input.assistantPreferencesSource && input.memoryPreferencesSource)) {
    return [];
  }

  const assistantModelRemaps = extractNestedStringRecord(
    input.assistantPreferencesSource,
    'MODEL_ID_MIGRATIONS',
    'packages/app-state/src/stores/assistant-model-id-migrations.ts'
  );
  const memoryModelTargetRemaps = extractStringRecord(
    input.memoryPreferencesSource,
    'MEMORY_MODEL_TARGET_MIGRATIONS',
    'packages/app-state/src/stores/assistant-memory-preferences-store.ts'
  );
  const failures = [];

  for (const row of collectDeletedRowsRequiringRemaps(migrationSummaries)) {
    if (row.type !== 'llm') {
      continue;
    }

    if (
      ASSISTANT_MODEL_PROVIDER_IDS.has(row.providerId) &&
      !assistantModelRemaps.get(row.providerId)?.has(row.id)
    ) {
      failures.push({
        file: 'packages/app-state/src/stores/assistant-model-id-migrations.ts',
        message: `Removed assistant catalog model ${modelKey(row)} is missing from MODEL_ID_MIGRATIONS.`,
      });
    }

    const target = memoryModelTarget(row);
    if (
      OBSERVATIONAL_MEMORY_PROVIDER_IDS.has(row.providerId) &&
      !memoryModelTargetRemaps.has(target)
    ) {
      failures.push({
        file: 'packages/app-state/src/stores/assistant-memory-preferences-store.ts',
        message: `Removed assistant memory model target ${target} is missing from MEMORY_MODEL_TARGET_MIGRATIONS.`,
      });
    }
  }

  return failures;
}

export function analyzeModelCatalogMigrationContract(input) {
  const migrationNames = extractMigrationArrayNames(input.migrationIndexSource);
  const migrationSummaries = input.migrationFiles.map(summarizeMigrationFile);
  const migrationByName = new Map(
    migrationSummaries
      .filter((migration) => migration.exportName)
      .map((migration) => [migration.exportName, migration])
  );
  const failures = [];

  for (const migration of migrationSummaries) {
    if (migration.catalogMutating && !migration.exportName) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration in ${migration.file} has no recognizable \`export const migrationNNN: Migration =\` declaration; the contract checker cannot verify its registration.`,
      });
      continue;
    }

    if (!migration.catalogMutating) {
      continue;
    }

    if (!migrationNames.has(migration.exportName)) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration ${migration.exportName} is missing from packages/db/src/migrations/index.ts migrations.`,
      });
    }
  }

  failures.push(...findRemovedAssistantModelRemapFailures(input, migrationSummaries));
  failures.push(...findStaticProviderRegistryFailures(input, migrationSummaries));
  if (input.providerCatalog !== undefined) {
    failures.push(...findCatalogKeyOrderFailures(input.providerCatalog));
  }

  return {
    catalogMutatingMigrations: migrationSummaries
      .filter((migration) => migration.catalogMutating)
      .map((migration) => migration.exportName ?? migration.file),
    failures,
    knownMigrationCount: migrationByName.size,
    migrations: [...migrationNames],
  };
}

export async function readMigrationFiles(rootDir) {
  const migrationsDir = path.join(rootDir, 'packages/db/src/migrations');
  const entries = await readdir(migrationsDir);
  const migrationFiles = entries.filter((entry) => /^\d{3}-.*\.ts$/.test(entry)).sort();

  return Promise.all(
    migrationFiles.map(async (entry) => {
      const file = path.posix.join('packages/db/src/migrations', entry);
      return {
        file,
        source: await readFile(path.join(rootDir, file), 'utf8'),
      };
    })
  );
}

export async function checkModelCatalogMigrationContract(rootDir = process.cwd()) {
  const [
    migrationFiles,
    migrationIndexSource,
    assistantPreferencesSource,
    memoryPreferencesSource,
    providerCatalogSource,
  ] = await Promise.all([
    readMigrationFiles(rootDir),
    readFile(path.join(rootDir, 'packages/db/src/migrations/index.ts'), 'utf8'),
    readFile(
      path.join(rootDir, 'packages/app-state/src/stores/assistant-model-id-migrations.ts'),
      'utf8'
    ),
    readFile(
      path.join(rootDir, 'packages/app-state/src/stores/assistant-memory-preferences-store.ts'),
      'utf8'
    ),
    readFile(path.join(rootDir, CATALOG_FILE), 'utf8'),
  ]);

  return analyzeModelCatalogMigrationContract({
    assistantPreferencesSource,
    memoryPreferencesSource,
    migrationFiles,
    migrationIndexSource,
    providerCatalog: JSON.parse(providerCatalogSource),
  });
}

async function main() {
  const result = await checkModelCatalogMigrationContract();
  if (result.failures.length > 0) {
    console.error('Model catalog migration contract failed.');
    console.error(
      'Catalog row migrations must be registered in the numbered manifest with a ledgerKey, removed assistant model IDs must have preference remap decisions, and provider-catalog.json must keep its object keys alphabetical.'
    );
    for (const failure of result.failures) {
      console.error(`- ${failure.file}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Model catalog migration contract passed (${result.catalogMutatingMigrations.length} catalog-mutating migrations checked).`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
