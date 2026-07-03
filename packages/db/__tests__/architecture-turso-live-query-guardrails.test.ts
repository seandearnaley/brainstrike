import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DB_PACKAGE_ROOT, '../..');
const PRODUCTION_SOURCE_ROOTS = ['apps', 'packages'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);
const SKIPPED_DIRECTORIES = new Set([
  '__tests__',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
]);
const BRAINSTRIKE_DB_NAMED_IMPORT_PATTERN =
  /import\s*(?:type\s*)?\{(?<imports>[^}]*)\}\s*from\s*['"]@brainstrike\/db['"]/g;

const LIVE_QUERY_CONSUMER_POLICIES = new Map<string, readonly RegExp[]>([
  [
    'packages/app-shell/src/cost-tracking/use-cross-root-cost.ts',
    [/runtimeEngine === 'pglite'/, /runtimeEngine === 'turso'/, /createAssistantThreadRepository/],
  ],
  [
    'packages/app-shell/src/use-file-mentions.ts',
    [/useBrainstrikeLiveQueryCapability\(\)/, /findByNameSubstring/, /repositorySnapshot/],
  ],
  [
    'packages/app-shell/src/use-om-segment-row.ts',
    [/runtimeEngine === 'pglite'/, /runtimeEngine === 'turso'/, /SQLITE_OM_ROW_QUERY/],
  ],
  [
    'packages/app-shell/src/use-quick-open-files.ts',
    [/useBrainstrikeLiveQueryCapability\(\)/, /findByNameSubstring/, /repositorySnapshot/],
  ],
  [
    'packages/db-explorer/src/hooks/use-collection-embedding-coverage.ts',
    [
      /useBrainstrikeLiveQueryCapability\(\)/,
      /getCollectionEmbeddingCoverage/,
      /repositorySnapshot/,
    ],
  ],
  [
    'packages/db-explorer/src/hooks/use-document-count.ts',
    [/useBrainstrikeLiveQueryCapability\(\)/, /getCoverageForSet/, /repositorySnapshot/],
  ],
  [
    'packages/db-explorer/src/hooks/use-file-collection-status.ts',
    [
      /useBrainstrikeLiveQueryCapability\(\)/,
      /getFileCollectionStatuses/,
      /repositoryStatusLoader/,
    ],
  ],
  [
    'packages/db-explorer/src/use-database-demo-data.ts',
    [/supportsPGliteCollectionQueries/, /usesRepositoryCollectionSnapshots/, /fallbackError/],
  ],
  [
    'packages/preferences/src/settings/tools/unified-tools-settings.tsx',
    [/useBrainstrikeLiveQueryCapability\(\)/, /liveQueryUnsupported/, /operationsSnapshotEnabled/],
  ],
  [
    'packages/vector-management/src/collection-select/collection-select.tsx',
    [/useBrainstrikeLiveQueryCapability\(\)/, /canUseSnapshot/, /embeddingSetsRepository/],
  ],
  [
    'packages/vector-management/src/vector-status/use-vector-queue-state.ts',
    [/liveQueryMetricsEnabled/, /snapshotReader/, /snapshotFallback/],
  ],
]);

function listProductionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('coverage-')) {
        continue;
      }
      files.push(...listProductionSourceFiles(path.join(root, entry.name)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

function normalizeRelativePath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function getBrainstrikeDbNamedImports(source: string): string[] {
  const imports: string[] = [];
  for (const match of source.matchAll(BRAINSTRIKE_DB_NAMED_IMPORT_PATTERN)) {
    const specifiers = match.groups?.['imports'] ?? '';
    for (const specifier of specifiers.split(',')) {
      const [rawImportedName = ''] = specifier
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const importedName = rawImportedName.trim();
      if (importedName) {
        imports.push(importedName);
      }
    }
  }
  return imports;
}

function findLiveQueryConsumers(): Map<string, string> {
  const consumers = new Map<string, string>();
  for (const sourceRoot of PRODUCTION_SOURCE_ROOTS) {
    for (const filePath of listProductionSourceFiles(path.join(REPO_ROOT, sourceRoot))) {
      const source = readFileSync(filePath, 'utf8');
      if (getBrainstrikeDbNamedImports(source).includes('useBrainstrikeLiveQuery')) {
        consumers.set(normalizeRelativePath(filePath), source);
      }
    }
  }
  return consumers;
}

describe('Turso live-query architecture guardrails', () => {
  it('classifies every production useBrainstrikeLiveQuery consumer', () => {
    const consumers = findLiveQueryConsumers();

    expect([...consumers.keys()].sort()).toEqual([...LIVE_QUERY_CONSUMER_POLICIES.keys()].sort());
  });

  it('keeps every production live-query consumer behind its documented runtime policy', () => {
    const consumers = findLiveQueryConsumers();
    const policyViolations: string[] = [];

    for (const [relativePath, requiredMarkers] of LIVE_QUERY_CONSUMER_POLICIES) {
      const source = consumers.get(relativePath);
      if (!source) {
        policyViolations.push(`${relativePath}: policy has no matching production consumer`);
        continue;
      }
      for (const requiredMarker of requiredMarkers) {
        if (!requiredMarker.test(source)) {
          policyViolations.push(`${relativePath}: missing ${requiredMarker}`);
        }
      }
    }

    expect(policyViolations).toEqual([]);
  });
});
