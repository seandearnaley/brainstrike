import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DB_PACKAGE_ROOT, '../..');
const PRODUCTION_TYPESCRIPT_SOURCE_ROOTS = ['apps', 'packages'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);
const SKIPPED_DIRECTORIES = new Set([
  '__tests__',
  '.turbo',
  'coverage',
  'dist',
  'fixtures',
  'mocks',
  'node_modules',
  'test-results',
]);
const DIRECT_PGLITE_IMPORT_PATTERN =
  /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<staticSpecifier>@electric-sql\/pglite(?:[^'"]*)?)['"]|\bimport\s*\(\s*['"](?<dynamicSpecifier>@electric-sql\/pglite(?:[^'"]*)?)['"]\s*\)/g;

const DIRECT_PGLITE_IMPORT_POLICIES = new Map<
  string,
  {
    readonly owner: string;
    readonly reason: string;
    readonly specifiers: readonly string[];
  }
>([
  [
    'apps/desktop/src/assistant-server/retrieval-tool.ts',
    {
      owner: 'desktop assistant retrieval',
      reason:
        'Explicit BRAINSTRIKE_DB_RUNTIME=pglite compatibility path while Turso retrieval uses repository capabilities.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'apps/desktop/src/db-main.ts',
    {
      owner: 'desktop DB host',
      reason: 'Explicit PGlite desktop runtime construction and extension loading.',
      specifiers: [
        '@electric-sql/pglite',
        '@electric-sql/pglite/contrib/pg_trgm',
        '@electric-sql/pglite/live',
        '@electric-sql/pglite-pgvector',
      ],
    },
  ],
  [
    'apps/desktop/src/ipc-domains/db-ipc.ts',
    {
      owner: 'desktop DB IPC types',
      reason: 'PGlite live-query IPC type surface for the explicit PGlite runtime.',
      specifiers: ['@electric-sql/pglite/live'],
    },
  ],
  [
    'packages/db/src/architecture/db-migration-authority.ts',
    {
      owner: 'DB migration authority',
      reason: 'PGlite/Postgres migration authority checks for the supported PGlite path.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/bootstrap/bootstrap-capability-probe.ts',
    {
      owner: 'PGlite bootstrap probe',
      reason: 'PGlite capability report for the explicit PGlite runtime.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/db-provider.tsx',
    {
      owner: 'shared DB provider',
      reason: 'Browser/PGlite provider construction while desktop Turso is host-owned.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/drizzle/database.ts',
    {
      owner: 'Drizzle PGlite adapter',
      reason: 'Typed Drizzle database creation for the PGlite runtime.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/drizzle/migrate.ts',
    {
      owner: 'Drizzle PGlite migrator',
      reason: 'PGlite/Postgres migration runner remains authoritative for PGlite stores.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/evaluation/retrieval-eval-runner.ts',
    {
      owner: 'retrieval evaluation harness',
      reason: 'Evaluation harness accepts a PGlite database for PGlite-backed runs.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/migrations/bootstrap.ts',
    {
      owner: 'PGlite migration bootstrap',
      reason: 'PGlite migration entrypoint for supported PGlite stores.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/migrations/migration-runner.ts',
    {
      owner: 'PGlite migration runner',
      reason: 'Numbered PGlite/Postgres migration runner uses the PGlite query contract.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/pglite-worker-entry.ts',
    {
      owner: 'PGlite web worker entry',
      reason: 'Dedicated PGlite worker runtime and engine-extension loading.',
      specifiers: [
        '@electric-sql/pglite',
        '@electric-sql/pglite/contrib/pg_trgm',
        '@electric-sql/pglite/worker',
        '@electric-sql/pglite-pgvector',
      ],
    },
  ],
  [
    'packages/db/src/repositories/file-chunk-repository.ts',
    {
      owner: 'PGlite file chunk repository',
      reason: 'Postgres/PGlite repository retained for explicit PGlite runtime compatibility.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/repositories/file-record-repository.ts',
    {
      owner: 'PGlite file record repository',
      reason: 'Postgres/PGlite repository retained for explicit PGlite runtime compatibility.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/repositories/repository-factory.ts',
    {
      owner: 'legacy repository factory',
      reason: 'Compatibility factory still distinguishes PGlite from Electron DB APIs.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
  [
    'packages/db/src/use-live-query.ts',
    {
      owner: 'PGlite live-query hook',
      reason: 'PGlite live-query implementation behind explicit live-query capability gates.',
      specifiers: ['@electric-sql/pglite/live'],
    },
  ],
  [
    'packages/db/src/wasm-loader.ts',
    {
      owner: 'PGlite WASM loader',
      reason: 'Shared PGlite construction and engine-extension loading for PGlite runtimes.',
      specifiers: [
        '@electric-sql/pglite',
        '@electric-sql/pglite/contrib/pg_trgm',
        '@electric-sql/pglite/live',
        '@electric-sql/pglite/worker',
        '@electric-sql/pglite-pgvector',
      ],
    },
  ],
  [
    'packages/token-cache/src/token-cache-store.ts',
    {
      owner: 'PGlite token cache store',
      reason: 'PGlite-backed token cache store retained for PGlite runtime compatibility.',
      specifiers: ['@electric-sql/pglite'],
    },
  ],
]);

interface DirectPGliteImport {
  readonly relativePath: string;
  readonly specifiers: readonly string[];
}

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

function findDirectPGliteImports(): DirectPGliteImport[] {
  const imports: DirectPGliteImport[] = [];
  for (const sourceRoot of PRODUCTION_TYPESCRIPT_SOURCE_ROOTS) {
    for (const filePath of listProductionSourceFiles(path.join(REPO_ROOT, sourceRoot))) {
      const source = readFileSync(filePath, 'utf8');
      const specifiers = new Set<string>();
      for (const match of source.matchAll(DIRECT_PGLITE_IMPORT_PATTERN)) {
        const specifier = match.groups?.['staticSpecifier'] ?? match.groups?.['dynamicSpecifier'];
        if (specifier) {
          specifiers.add(specifier);
        }
      }
      if (specifiers.size > 0) {
        imports.push({
          relativePath: normalizeRelativePath(filePath),
          specifiers: [...specifiers].sort(),
        });
      }
    }
  }
  return imports;
}

describe('PGlite import architecture guardrails', () => {
  it('keeps every production direct PGlite import explicitly owned', () => {
    const imports = findDirectPGliteImports();

    expect(imports.map((entry) => entry.relativePath).sort()).toEqual(
      [...DIRECT_PGLITE_IMPORT_POLICIES.keys()].sort()
    );

    for (const entry of imports) {
      expect(entry.specifiers).toEqual(
        [...(DIRECT_PGLITE_IMPORT_POLICIES.get(entry.relativePath)?.specifiers ?? [])].sort()
      );
    }
  });

  it('documents an owner and reason for each allowed direct PGlite import', () => {
    const policyViolations: string[] = [];

    for (const [relativePath, policy] of DIRECT_PGLITE_IMPORT_POLICIES) {
      if (!policy.owner.trim()) {
        policyViolations.push(`${relativePath}: missing owner`);
      }
      if (!policy.reason.trim()) {
        policyViolations.push(`${relativePath}: missing reason`);
      }
    }

    expect(policyViolations).toEqual([]);
  });

  it('keeps desktop PGlite import reasons explicit-only', () => {
    const policyViolations: string[] = [];

    for (const [relativePath, policy] of DIRECT_PGLITE_IMPORT_POLICIES) {
      if (!relativePath.startsWith('apps/desktop/')) {
        continue;
      }
      const reason = policy.reason.toLowerCase();
      if (!reason.includes('explicit')) {
        policyViolations.push(`${relativePath}: desktop PGlite reason must be explicit`);
      }
      if (reason.includes('fallback') || reason.includes('profile-continuity')) {
        policyViolations.push(
          `${relativePath}: desktop PGlite reason must not describe fallback/profile continuity`
        );
      }
    }

    expect(policyViolations).toEqual([]);
  });

  it('keeps web server Mastra storage off PGlite-specific memory factories', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'apps/web/src/server/web-mastra-storage.ts'),
      'utf8'
    );

    expect(source).not.toContain('@brainstrike/agent/pglite-mastra-memory');
  });
});
