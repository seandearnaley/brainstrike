#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const MIGRATION_EXPORT_PATTERN = /export\s+const\s+(migration\d{3}[A-Za-z0-9_]*)\s*:\s*Migration\s*=/;
// Keep this literal table list in sync with the model catalog schema. The check
// intentionally scans whole migration files, including down blocks/comments, so
// ambiguous catalog mentions fail closed instead of silently bypassing ledger checks.
const CATALOG_ROW_MUTATION_PATTERN =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:models|providers)"?\b/i;
const ASSISTANT_MODEL_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'openrouter', 'local']);
const OBSERVATIONAL_MEMORY_PROVIDER_IDS = new Set([
  'openai',
  'anthropic',
  'google',
  'openrouter',
]);

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

function extractCustomMigrationNames(source) {
  const names = new Set();
  const pattern =
    /customMigration\(\s*['"][^'"]+['"]\s*,\s*(migration\d{3}[A-Za-z0-9_]*)/g;
  for (const match of source.matchAll(pattern)) {
    names.add(match[1]);
  }
  return names;
}

function getPropertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function parseTypeScriptSource(source, fileName) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
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
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
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

function summarizeMigrationFile(file) {
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

    return { value, endIndex: index + 1 };
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
      const values = splitTopLevelCommaValues(block).map((value) => extractSqlStringLiterals(value)[0]);
      const id = values[columnIndex.get('id')];
      const providerId = values[columnIndex.get('provider_id')];
      if (!id || !providerId) {
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

  const deleteIdsPattern = /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bid\s+IN\s*\(([\s\S]*?)\)/gi;
  for (const match of sql.matchAll(deleteIdsPattern)) {
    operations.push({
      index: match.index,
      kind: 'delete-ids',
      ids: extractSqlStringLiterals(match[1]),
    });
  }

  const deleteIdPattern = /DELETE\s+FROM\s+"?models"?[\s\S]*?\bWHERE\b[\s\S]*?\bid\s*=\s*'((?:''|[^'])*)'/gi;
  for (const match of sql.matchAll(deleteIdPattern)) {
    operations.push({
      index: match.index,
      kind: 'delete-ids',
      ids: [match[1].replaceAll("''", "'")],
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

function memoryModelTarget(row) {
  if (row.providerId === 'openrouter') {
    return `openrouter/${row.id}`;
  }
  return `${row.providerId}/${row.id}`;
}

function collectLatestDeletedRows(migrationSummaries) {
  const latestDeleteMigration = migrationSummaries.findLast((migration) =>
    migration.operations.some((operation) => operation.kind.startsWith('delete-'))
  );

  if (!latestDeleteMigration) {
    return [];
  }

  const snapshot = new Map();
  const deletedRows = [];

  for (const migration of migrationSummaries) {
    const collectDeletes = migration.file === latestDeleteMigration.file;
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

  return deletedRows;
}

function findRemovedAssistantModelRemapFailures(input, migrationSummaries) {
  if (!(input.assistantPreferencesSource && input.memoryPreferencesSource)) {
    return [];
  }

  const assistantModelRemaps = extractNestedStringRecord(
    input.assistantPreferencesSource,
    'MODEL_ID_MIGRATIONS',
    'packages/preferences/src/stores/assistant-preferences-store.ts'
  );
  const memoryModelTargetRemaps = extractStringRecord(
    input.memoryPreferencesSource,
    'MEMORY_MODEL_TARGET_MIGRATIONS',
    'packages/preferences/src/stores/assistant-memory-preferences-store.ts'
  );
  const failures = [];

  for (const row of collectLatestDeletedRows(migrationSummaries)) {
    if (row.type !== 'llm') {
      continue;
    }

    if (
      ASSISTANT_MODEL_PROVIDER_IDS.has(row.providerId) &&
      !assistantModelRemaps.get(row.providerId)?.has(row.id)
    ) {
      failures.push({
        file: 'packages/preferences/src/stores/assistant-preferences-store.ts',
        message: `Removed assistant catalog model ${modelKey(row)} is missing from MODEL_ID_MIGRATIONS.`,
      });
    }

    const target = memoryModelTarget(row);
    if (OBSERVATIONAL_MEMORY_PROVIDER_IDS.has(row.providerId) && !memoryModelTargetRemaps.has(target)) {
      failures.push({
        file: 'packages/preferences/src/stores/assistant-memory-preferences-store.ts',
        message: `Removed assistant memory model target ${target} is missing from MEMORY_MODEL_TARGET_MIGRATIONS.`,
      });
    }
  }

  return failures;
}

export function analyzeModelCatalogMigrationContract(input) {
  const migrationNames = extractMigrationArrayNames(input.migrationIndexSource);
  const customMigrationNames = extractCustomMigrationNames(input.drizzleMigrateSource);
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

    if (!customMigrationNames.has(migration.exportName)) {
      failures.push({
        file: migration.file,
        message: `Catalog-mutating migration ${migration.exportName} is missing from packages/db/src/drizzle/migrate.ts customMigrations.`,
      });
    }
  }

  for (const customMigrationName of customMigrationNames) {
    if (migrationNames.has(customMigrationName)) {
      continue;
    }

    failures.push({
      file: 'packages/db/src/drizzle/migrate.ts',
      message: `Custom migration ${customMigrationName} is missing from packages/db/src/migrations/index.ts migrations.`,
    });
  }

  failures.push(...findRemovedAssistantModelRemapFailures(input, migrationSummaries));

  return {
    catalogMutatingMigrations: migrationSummaries
      .filter((migration) => migration.catalogMutating)
      .map((migration) => migration.exportName ?? migration.file),
    customMigrations: [...customMigrationNames],
    failures,
    migrations: [...migrationNames],
    knownMigrationCount: migrationByName.size,
  };
}

async function readMigrationFiles(rootDir) {
  const migrationsDir = path.join(rootDir, 'packages/db/src/migrations');
  const entries = await readdir(migrationsDir);
  const migrationFiles = entries.filter((entry) => /^\d{3}-.*\.ts$/.test(entry)).sort();

  return Promise.all(
    migrationFiles.map(async (entry) => {
      const file = path.join('packages/db/src/migrations', entry);
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
    drizzleMigrateSource,
    assistantPreferencesSource,
    memoryPreferencesSource,
  ] = await Promise.all([
    readMigrationFiles(rootDir),
    readFile(path.join(rootDir, 'packages/db/src/migrations/index.ts'), 'utf8'),
    readFile(path.join(rootDir, 'packages/db/src/drizzle/migrate.ts'), 'utf8'),
    readFile(path.join(rootDir, 'packages/preferences/src/stores/assistant-preferences-store.ts'), 'utf8'),
    readFile(
      path.join(rootDir, 'packages/preferences/src/stores/assistant-memory-preferences-store.ts'),
      'utf8'
    ),
  ]);

  return analyzeModelCatalogMigrationContract({
    assistantPreferencesSource,
    drizzleMigrateSource,
    memoryPreferencesSource,
    migrationFiles,
    migrationIndexSource,
  });
}

async function main() {
  const result = await checkModelCatalogMigrationContract();
  if (result.failures.length > 0) {
    console.error('Model catalog migration contract failed.');
    console.error(
      'Catalog row migrations must be registered in both migration runners, and removed assistant model IDs must have preference remap decisions.'
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
