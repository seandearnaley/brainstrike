import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DB_PACKAGE_ROOT, '../..');
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
const TURSO_BROWSER_DB_CLIENT_IMPORT_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<staticSpecifier>@tursodatabase\/(?:database(?:-wasm)?(?:\/(?:vite|bundle|turbopack))?|sync|serverless)|@libsql\/client(?:\/web)?)['"]|\bimport\s*\(\s*['"](?<dynamicSpecifier>@tursodatabase\/(?:database(?:-wasm)?(?:\/(?:vite|bundle|turbopack))?|sync|serverless)|@libsql\/client(?:\/web)?)['"]\s*\)/g;
const LOCAL_STATIC_SPECIFIER_PATTERN =
  /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s*)?['"](?<specifier>\.{1,2}\/[^'"]+)['"]/g;
// Local DYNAMIC imports are followed too: db-provider reaches the browser
// Turso WASM bootstrap through a lazy `import('./bootstrap/...')` loader, and
// the scan must not lose that edge just because it is code-split.
const LOCAL_DYNAMIC_SPECIFIER_PATTERN =
  /\bimport\s*\(\s*['"](?<specifier>\.{1,2}\/[^'"]+)['"]\s*\)/g;

const BROWSER_BUNDLE_ENTRYPOINTS = [
  'apps/web/src/main.tsx',
  'apps/web/src/workers',
  'packages/db/src/browser-pglite-storage.ts',
  'packages/db/src/db-provider.tsx',
  'packages/db/src/index.ts',
  'packages/db/src/pglite-worker-entry.ts',
  'packages/db/src/turso/browser-wasm-client.ts',
  'packages/db/src/wasm-loader.ts',
] as const;

const REQUIRED_LEDGER_PHRASES = [
  '## Browser Runtime Ownership Decision',
  'Browser/client DB storage has completed the staged Turso WASM migration to its default flip',
  'as of the A7 cutover (2026-07-05) the web platform default is browser Turso WASM',
  '`@tursodatabase/database-wasm` is the only approved browser-local Turso database package',
  '`@tursodatabase/database-wasm/vite` is the Vite/browser import surface',
  '@tursodatabase/serverless is a remote fetch client, not a local-first browser database',
  'Browser Turso WASM has a dedicated bootstrap readiness report and DbProvider integration behind an explicit runtime-selection opt-in',
  'Turso WASM is the browser default runtime as of the A7 cutover decision (2026-07-05)',
  '`VITE_BRAINSTRIKE_DB_RUNTIME=pglite` is the explicit web PGlite opt-out',
  'runtime parity by the two-lane parity contract suite',
  'reset/clear (backup/export) ownership and OPFS offline durability by the browser reset-and-durability slice',
  'Browser OPFS Durability And Storage Pressure (2026-07-05)',
  'Browser Foreign-Key Connection Scope Finding (2026-07-05)',
] as const;

const REJECTED_LEDGER_PHRASES = [
  'The current official Turso TypeScript docs do not provide an equivalent browser-local embedded database surface',
  'The final PGlite dependency-removal pass is blocked until browser-local storage has a supported Turso replacement or browser support is explicitly dropped',
  // Superseded by the A4 provider-integration slice: the ledger must not
  // regress to claiming provider integration is still outstanding.
  'Browser PGlite remains only until the WASM runtime has provider integration',
  // Superseded by the A6 runtime-parity slice: the ledger must not regress to
  // listing runtime parity tests as an outstanding browser-cutover gate.
  'Browser PGlite remains the browser default until backup/export ownership, offline behavior, and runtime parity tests are proven',
  // Superseded by the A7-prep reset-and-durability slice: the ledger must not
  // regress to listing backup/export ownership or offline behavior as
  // outstanding browser-cutover gates.
  'Browser PGlite remains the browser default until backup/export ownership and offline behavior are proven',
  // Superseded by the same slice: browser Turso clear-all and factory reset
  // are implemented with explicit OPFS ownership, no longer fail-closed stubs.
  'clear-all and factory reset fail closed until they own OPFS store deletion explicitly',
  // Superseded by the A7 cutover slice (2026-07-05): the web default IS Turso
  // now; the ledger must not regress to describing PGlite as the browser
  // default awaiting a future flip.
  'Browser PGlite remains the browser default only until the A7 cutover decision flips the default',
  // Superseded by the same slice: navigator.storage.persist() is requested at
  // browser-Turso boot (log-only, non-gating), no longer a proposed follow-up.
  'it is proposed as an explicit follow-up for the A7 cutover decision',
  // Superseded by the A7 cutover slice (2026-07-05): the migration has reached
  // its default flip, so the ledger must not regress to describing it as still
  // "entering a staged migration" with a PGlite-backed production default.
  'Current browser/client DB storage is entering a staged Turso WASM migration',
  'The current production browser DB provider remains PGlite-backed by design',
] as const;

const APPROVED_TURSO_BROWSER_DB_CLIENT_IMPORTS = new Map<string, readonly string[]>([
  ['packages/db/src/turso/browser-wasm-client.ts', ['@tursodatabase/database-wasm/vite']],
]);

/**
 * Single-construction-site rule for the browser Turso WASM store (ledger:
 * "Browser Single-Writer Ownership Finding (2026-07-05)"): the vendor OPFS
 * worker dedupes file registration by path, so a second `connect()` in the
 * SAME page silently SHARES the one sync access handle instead of failing —
 * split-brain by construction. `./turso/browser-wasm-client` is a public
 * subpath export, so the entrypoint-graph scan above would never see a rogue
 * `connect()` from a feature package. This repo-wide scan pins the only
 * production call sites of `openTursoBrowserWasmDatabase(` to the
 * DbProvider-owned seam. The negative lookbehind excludes the function
 * DECLARATION in browser-wasm-client.ts (a declaration is not a call site).
 */
const BROWSER_STORE_OPEN_CALL_PATTERN = /(?<!function )\bopenTursoBrowserWasmDatabase\s*\(/;
const APPROVED_BROWSER_STORE_OPEN_CALL_SITES = [
  'packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts',
  'packages/db/src/db-provider.tsx',
] as const;

const REQUIRED_CROSS_ORIGIN_HEADERS = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
} as const;

interface BrowserDbClientImport {
  readonly relativePath: string;
  readonly specifier: string;
}

type SourceReader = (absolutePath: string) => string;

function listSourceFiles(entrypoint: string): string[] {
  const absolutePath = path.join(REPO_ROOT, entrypoint);
  expect(
    existsSync(absolutePath),
    `${entrypoint} must exist; update BROWSER_BUNDLE_ENTRYPOINTS if the browser DB entry surface changes`
  ).toBe(true);

  const stat = statSync(absolutePath);
  if (stat.isFile()) {
    return [absolutePath];
  }

  const files: string[] = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    const entryPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('coverage-')) {
        continue;
      }
      files.push(...listSourceFiles(path.relative(REPO_ROOT, entryPath)));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizeRelativePath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function extractLocalStaticSpecifiers(source: string): string[] {
  const staticSpecifiers = Array.from(source.matchAll(LOCAL_STATIC_SPECIFIER_PATTERN), (match) => {
    const specifier = match.groups?.['specifier'];
    expect(specifier, 'local static import/export regex must capture a specifier').toBeTruthy();
    return specifier as string;
  });
  const dynamicSpecifiers = Array.from(
    source.matchAll(LOCAL_DYNAMIC_SPECIFIER_PATTERN),
    (match) => {
      const specifier = match.groups?.['specifier'];
      expect(specifier, 'local dynamic import regex must capture a specifier').toBeTruthy();
      return specifier as string;
    }
  );
  return [...staticSpecifiers, ...dynamicSpecifiers];
}

function extractTursoBrowserDbClientImports(
  source: string,
  relativePath: string
): BrowserDbClientImport[] {
  const imports: BrowserDbClientImport[] = [];
  for (const match of source.matchAll(TURSO_BROWSER_DB_CLIENT_IMPORT_PATTERN)) {
    const specifier = match.groups?.['staticSpecifier'] ?? match.groups?.['dynamicSpecifier'];
    if (specifier) {
      imports.push({
        relativePath,
        specifier,
      });
    }
  }
  return imports;
}

function resolveLocalSourceSpecifier(fromFilePath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(fromFilePath), specifier);
  const candidates = path.extname(basePath)
    ? [
        basePath,
        basePath.replace(/\.(?:js|mjs)$/, '.ts'),
        basePath.replace(/\.(?:js|mjs)$/, '.tsx'),
        basePath.replace(/\.(?:js|mjs)$/, '.mts'),
      ]
    : [
        ...Array.from(SOURCE_EXTENSIONS, (extension) => `${basePath}${extension}`),
        ...Array.from(SOURCE_EXTENSIONS, (extension) => path.join(basePath, `index${extension}`)),
      ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findTursoBrowserDbClientImportsFromFiles(
  entryFiles: readonly string[],
  readSource: SourceReader = (absolutePath) => readFileSync(absolutePath, 'utf8')
): BrowserDbClientImport[] {
  const imports: BrowserDbClientImport[] = [];
  const pending = [...entryFiles];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const filePath = pending.shift();
    expect(filePath, 'pending browser scan file path must be defined').toBeTruthy();
    const absolutePath = filePath as string;
    if (visited.has(absolutePath)) {
      continue;
    }
    visited.add(absolutePath);

    const source = readSource(absolutePath);
    imports.push(
      ...extractTursoBrowserDbClientImports(source, normalizeRelativePath(absolutePath))
    );

    for (const specifier of extractLocalStaticSpecifiers(source)) {
      const resolvedPath = resolveLocalSourceSpecifier(absolutePath, specifier);
      if (resolvedPath) {
        pending.push(resolvedPath);
      }
    }
  }

  return imports;
}

function uniqueBrowserDbClientImports(
  imports: readonly BrowserDbClientImport[]
): BrowserDbClientImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.relativePath}\0${entry.specifier}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findBrowserStoreOpenCallSites(
  readSource: SourceReader = (absolutePath) => readFileSync(absolutePath, 'utf8')
): string[] {
  // Repo-wide production scan (apps/ + packages/), reusing the same
  // directory-skip rules as the entrypoint walker: __tests__, dist,
  // fixtures, mocks, node_modules, coverage, .turbo, test-results.
  const files = [...listSourceFiles('apps'), ...listSourceFiles('packages')];
  return files
    .filter((filePath) => BROWSER_STORE_OPEN_CALL_PATTERN.test(readSource(filePath)))
    .map(normalizeRelativePath)
    .sort();
}

function findTursoBrowserDbClientImports(): BrowserDbClientImport[] {
  // This is a deliberate browser entrypoint allowlist: add new browser DB
  // entrypoints here when the runtime surface changes. Server-only web code
  // belongs outside this list because it may legitimately use Turso directly.
  return uniqueBrowserDbClientImports(
    findTursoBrowserDbClientImportsFromFiles(BROWSER_BUNDLE_ENTRYPOINTS.flatMap(listSourceFiles))
  );
}

describe('browser runtime ownership guardrails', () => {
  it('documents the browser-local storage decision before final PGlite removal', () => {
    const ledger = readFileSync(
      path.join(REPO_ROOT, 'docs/turso-migration/migration-ledger.md'),
      'utf8'
    );

    // Prose in the ledger is hard-wrapped, so phrase checks must survive
    // re-wrapping; only real wording changes should fail this guardrail.
    const normalizedLedger = ledger.replace(/\s+/g, ' ');

    for (const phrase of REQUIRED_LEDGER_PHRASES) {
      expect(normalizedLedger).toContain(phrase.replace(/\s+/g, ' '));
    }
    for (const phrase of REJECTED_LEDGER_PHRASES) {
      expect(normalizedLedger).not.toContain(phrase.replace(/\s+/g, ' '));
    }
  });

  it('pins the Turso browser WASM package in the DB package dependency graph', () => {
    const dbPackage = JSON.parse(
      readFileSync(path.join(DB_PACKAGE_ROOT, 'package.json'), 'utf8')
    ) as {
      readonly dependencies?: Record<string, string>;
    };

    expect(dbPackage.dependencies?.['@tursodatabase/database']).toBe('^0.6.1');
    expect(dbPackage.dependencies?.['@tursodatabase/database-wasm']).toBe('^0.6.1');
  });

  it('keeps root AGENTS embedding-host storage wording aligned with runtime ownership', () => {
    const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');

    expect(agents).not.toMatch(
      /Hidden host renderer[\s\S]*It pulls jobs from the PGlite-backed `job_queue`\./
    );
    expect(agents).toContain('The hidden host selects runtime-specific embedding worker storage.');
    expect(agents).toContain('Desktop Turso queue mutations go through DB-host owner IPC/actions.');
  });

  it('allows only the owned Turso WASM client seam in browser DB bundle entrypoints', () => {
    expect(findTursoBrowserDbClientImports()).toEqual(
      [...APPROVED_TURSO_BROWSER_DB_CLIENT_IMPORTS.entries()].map(([relativePath, specifiers]) => ({
        relativePath,
        specifier: specifiers[0],
      }))
    );
  });

  it('restricts production browser Turso store open call sites to the DbProvider-owned seam', () => {
    expect(findBrowserStoreOpenCallSites()).toEqual([...APPROVED_BROWSER_STORE_OPEN_CALL_SITES]);
  });

  it('detects synthetic browser store open call sites and ignores the declaration', () => {
    // Direct call, method-style call, and callback-wrapped call all count.
    expect(
      BROWSER_STORE_OPEN_CALL_PATTERN.test("await openTursoBrowserWasmDatabase({ path: 'x.db' });")
    ).toBe(true);
    expect(
      BROWSER_STORE_OPEN_CALL_PATTERN.test('runtime.openTursoBrowserWasmDatabase({ path })')
    ).toBe(true);
    // The declaration in browser-wasm-client.ts is not a call site.
    expect(
      BROWSER_STORE_OPEN_CALL_PATTERN.test('export async function openTursoBrowserWasmDatabase(')
    ).toBe(false);
    // Bare references (re-exports, property shorthand) are not call sites.
    expect(
      BROWSER_STORE_OPEN_CALL_PATTERN.test(
        'openTursoBrowserWasmDatabase: clientModule.openTursoBrowserWasmDatabase,'
      )
    ).toBe(false);

    // A rogue call site introduced anywhere in the scanned tree is reported.
    const rogueFile = path.join(REPO_ROOT, 'packages/db/src/turso/browser-wasm-client.ts');
    const sites = findBrowserStoreOpenCallSites((absolutePath) =>
      absolutePath === rogueFile
        ? "const db = await openTursoBrowserWasmDatabase({ path: 'rogue.db' });"
        : ''
    );
    expect(sites).toEqual(['packages/db/src/turso/browser-wasm-client.ts']);
  });

  it('keeps the browser WASM bootstrap out of the browser-facing DB barrel (DbProvider owns bundling via its lazy loader)', () => {
    // Provider integration owns bundling now: db-provider reaches the
    // bootstrap through a code-split dynamic import. The barrel must still
    // never re-export the bootstrap statically — that would eagerly pull the
    // Turso WASM runtime into every browser bundle, including PGlite-default
    // builds.
    const dbBarrel = readFileSync(path.join(REPO_ROOT, 'packages/db/src/index.ts'), 'utf8');

    expect(dbBarrel).not.toContain('./bootstrap/turso-browser-wasm-bootstrap.js');
  });

  it('follows local dynamic imports from browser bundle entrypoints', () => {
    const providerPath = path.join(REPO_ROOT, 'packages/db/src/db-provider.tsx');
    const bootstrapPath = path.join(
      REPO_ROOT,
      'packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts'
    );
    const sources = new Map([
      [providerPath, "await import('./bootstrap/turso-browser-wasm-bootstrap.js');"],
      [bootstrapPath, "import { connect } from '@tursodatabase/database-wasm/vite';"],
    ]);

    expect(
      findTursoBrowserDbClientImportsFromFiles([providerPath], (absolutePath) => {
        const source = sources.get(absolutePath);
        expect(
          source,
          `test source missing for ${normalizeRelativePath(absolutePath)}`
        ).toBeTruthy();
        return source as string;
      })
    ).toEqual([
      {
        relativePath: 'packages/db/src/bootstrap/turso-browser-wasm-bootstrap.ts',
        specifier: '@tursodatabase/database-wasm/vite',
      },
    ]);
  });

  it('detects non-WASM Turso and libSQL clients re-exported from browser-facing barrels', () => {
    expect(
      extractTursoBrowserDbClientImports(
        "export { createClient } from '@libsql/client/web';",
        'packages/db/src/index.ts'
      )
    ).toEqual([
      {
        relativePath: 'packages/db/src/index.ts',
        specifier: '@libsql/client/web',
      },
    ]);
  });

  it('follows local re-exports from browser-facing barrels', () => {
    const barrelPath = path.join(REPO_ROOT, 'packages/db/src/index.ts');
    const localModulePath = path.join(REPO_ROOT, 'packages/db/src/turso/owner-client.ts');
    const sources = new Map([
      [barrelPath, "export * from './turso/owner-client.js';"],
      [localModulePath, "import { connect } from '@tursodatabase/database';"],
    ]);

    expect(
      findTursoBrowserDbClientImportsFromFiles([barrelPath], (absolutePath) => {
        const source = sources.get(absolutePath);
        expect(
          source,
          `test source missing for ${normalizeRelativePath(absolutePath)}`
        ).toBeTruthy();
        return source as string;
      })
    ).toEqual([
      {
        relativePath: 'packages/db/src/turso/owner-client.ts',
        specifier: '@tursodatabase/database',
      },
    ]);
  });

  it('classifies approved browser WASM imports separately from rejected Turso clients', () => {
    expect(
      extractTursoBrowserDbClientImports(
        "import { connect } from '@tursodatabase/database-wasm/vite';",
        'packages/db/src/turso/browser-wasm-client.ts'
      )
    ).toEqual([
      {
        relativePath: 'packages/db/src/turso/browser-wasm-client.ts',
        specifier: '@tursodatabase/database-wasm/vite',
      },
    ]);
  });

  it('keeps web dev preview and Vercel responses cross-origin isolated for browser WASM', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/vite.config.mts'), 'utf8');
    const vercelConfig = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'apps/web/vercel.json'), 'utf8')
    ) as {
      readonly headers?: Array<{
        readonly headers?: Array<{ readonly key?: string; readonly value?: string }>;
        readonly source?: string;
      }>;
    };

    for (const [header, value] of Object.entries(REQUIRED_CROSS_ORIGIN_HEADERS)) {
      expect(viteConfig).toMatch(
        new RegExp(
          `server:\\s*{[\\s\\S]*headers:\\s*{[\\s\\S]*['"]${header}['"]:\\s*['"]${value}['"]`
        )
      );
      expect(viteConfig).toMatch(
        new RegExp(
          `preview:\\s*{[\\s\\S]*headers:\\s*{[\\s\\S]*['"]${header}['"]:\\s*['"]${value}['"]`
        )
      );
    }

    const allRouteHeaders = vercelConfig.headers?.find((entry) => entry.source === '/(.*)');
    expect(allRouteHeaders, 'apps/web/vercel.json must define all-route headers').toBeTruthy();
    const productionHeaders = new Map(
      allRouteHeaders?.headers?.map((entry) => [entry.key, entry.value]) ?? []
    );
    expect(Object.fromEntries(productionHeaders)).toMatchObject(REQUIRED_CROSS_ORIGIN_HEADERS);
  });

  it('keeps Turso browser WASM packages out of Vite dependency prebundling', () => {
    const viteConfig = readFileSync(path.join(REPO_ROOT, 'apps/web/vite.config.mts'), 'utf8');

    expect(viteConfig).toMatch(
      /optimizeDeps:\s*{[\s\S]*exclude:\s*\[[\s\S]*['"]@tursodatabase\/database-wasm['"]/
    );
    expect(viteConfig).toMatch(
      /optimizeDeps:\s*{[\s\S]*exclude:\s*\[[\s\S]*['"]@tursodatabase\/database-wasm-common['"]/
    );
  });
});
