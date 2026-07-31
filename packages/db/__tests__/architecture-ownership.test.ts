import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readDbSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('db package ownership', () => {
  it('keeps the root public API routed through owned barrels', () => {
    const rootIndex = readDbSource('src/index.ts');

    expect(rootIndex).toContain('./managed-cache/index.js');
    expect(rootIndex).toContain('./migrations/index.js');
    expect(rootIndex).toContain('./queue/index.js');
    expect(rootIndex).toContain('./repositories/index.js');
    expect(rootIndex).toContain('./schema/index.js');
    expect(rootIndex).toContain('./search/index.js');

    expect(rootIndex).not.toContain('./managed-cache/apply-managed-cache-batch.js');
    expect(rootIndex).not.toContain('./queue/job-queue.js');
    // BST-990 root-API drift regressions this guard originally missed: the
    // root must not bypass the owned barrels for implementation modules —
    // and never export an underscore-private module directly.
    expect(rootIndex).not.toContain('./repositories/_shared.js');
    expect(rootIndex).not.toContain('./repositories/file-chunk-repository.js');
    expect(rootIndex).not.toContain('./repositories/tool-output-artifact-repository.js');
    expect(rootIndex).not.toContain('./migrations/dimension-index-helpers.js');
    // BST-990 seam: the root barrel is React-FREE. Its export-star of the
    // provider previously loaded React at module init in Electron main and
    // the embedding workers (Node ESM does not tree-shake export *). React
    // consumers import '@brainstrike/db/react'.
    expect(rootIndex).not.toContain('./db-provider.js');
    expect(rootIndex).not.toContain('./use-live-query.js');
    expect(rootIndex).not.toContain('./use-drizzle-live-query.js');
  });

  it('keeps the root barrel module graph React-free (the real invariant)', () => {
    // The name-pin assertions above catch the KNOWN three modules; this walks
    // the root barrel's transitive relative import graph and asserts no
    // reachable module imports React — so a hook added to any owned barrel
    // later cannot silently reintroduce React into Electron main and the
    // embedding workers (review #2164; that regression would be exactly as
    // invisible as the original defect).
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    const nodePath = require('node:path') as typeof import('node:path');
    const srcRoot = nodePath.resolve(process.cwd(), 'src');
    const importRe = /(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gu;
    // Matches both the from-form and a bare side-effect `import 'react'`.
    const reactImportRe = /(?:(?:import|export)[^'"]*from\s+|import\s+)['"]react(?:\/[^'"]*)?['"]/u;
    const visited = new Set<string>();
    const queue = [nodePath.join(srcRoot, 'index.ts')];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      expect(
        reactImportRe.test(source),
        `${nodePath.relative(srcRoot, file)} imports React but is reachable from the root barrel`
      ).toBe(false);
      for (const match of source.matchAll(importRe)) {
        const spec = (match[1] as string).replace(/\.js$/u, '');
        for (const candidate of [`${spec}.ts`, `${spec}.tsx`, `${spec}/index.ts`]) {
          const resolved = nodePath.resolve(nodePath.dirname(file), candidate);
          if (existsSync(resolved)) {
            queue.push(resolved);
            break;
          }
        }
      }
    }
    // Anti-vacuity: the walk must actually cover the package.
    expect(visited.size).toBeGreaterThan(50);
  });

  it('keeps the React entry carrying the provider and live-query layer', () => {
    const reactEntry = readDbSource('src/react.ts');
    expect(reactEntry).toMatch(/export \{[^}]*DbProvider[^}]*\} from '\.\/db-provider\.js'/su);
    expect(reactEntry).toMatch(
      /export \{[^}]*usePGliteLiveQuery[^}]*\} from '\.\/use-live-query\.js'/su
    );
    expect(reactEntry).toMatch(
      /export \{[^}]*useDrizzleLiveQuery[^}]*\} from '\.\/use-drizzle-live-query\.js'/su
    );
  });

  it('keeps the owned barrels carrying their implementation modules', () => {
    // The other half of the routing contract: the symbols the root dropped
    // must stay reachable THROUGH the barrels. Match the EXPORT form
    // explicitly — a bare `toContain("from './x.js'")` would be satisfied by
    // a plain import line just as happily (review #2159).
    const repositoriesBarrel = readDbSource('src/repositories/index.ts');
    expect(repositoriesBarrel).toMatch(/export \{[^}]*\} from '\.\/_shared\.js'/u);
    expect(repositoriesBarrel).toMatch(
      /export \{[^}]*\} from '\.\/tool-output-artifact-repository\.js'/u
    );

    const migrationsBarrel = readDbSource('src/migrations/index.ts');
    expect(migrationsBarrel).toMatch(/export \{[^}]*\} from '\.\/dimension-index-helpers\.js'/u);
  });

  it('keeps engine helpers out of the React module export chain', () => {
    // use-live-query may IMPORT the escape helper for its own queries, but
    // must not re-EXPORT it: the root exports it from
    // pglite-live-query-format directly, and a second route through the React
    // module couples engine consumers to the React layer (BST-990).
    const useLiveQuery = readDbSource('src/use-live-query.ts');
    expect(useLiveQuery).not.toMatch(
      /export \{[^}]*escapePGliteLiveQueryFormatPercents[^}]*\} from/u
    );
    // The realistic bypass of the named-export check (review #2159).
    expect(useLiveQuery).not.toContain("export * from './pglite-live-query-format.js'");
  });

  it('documents the owned db surfaces and focused local verification commands', () => {
    const readme = readDbSource('README.md');

    expect(readme).toContain('Domain Ownership');
    expect(readme).toContain('queue');
    expect(readme).toContain('migrations');
    expect(readme).toContain('repositories');
    expect(readme).toContain('search');
    expect(readme).toContain('schema');
    expect(readme).toContain('pnpm --filter @brainstrike/db exec vitest run');
  });
});
