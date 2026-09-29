import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveThroughAliases,
  workspaceSrcAliases,
} from '@brainstrike/test-utils/workspace-src-aliases';
import { describe, expect, it } from 'vitest';

function readWebViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

function readWebVitestConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vitest.config.mts'), 'utf8');
}

const PACKAGES_DIR = path.resolve(process.cwd(), '../../packages');

function readFileExplorerTsupConfig(): string {
  return readFileSync(path.resolve(PACKAGES_DIR, 'file-explorer/tsup.config.ts'), 'utf8');
}

/**
 * Registry entries. Deliberately NOT loading the real vite.config.mts here
 * (e.g. via Vite's `loadConfigFromFile`): that file's own top-level imports
 * (`@brainstrike/build-utils`, `@brainstrike/utils`) require those packages'
 * built `dist` to even load, which would make this test — unlike every other
 * test in this suite since B4 dropped `test.dependsOn: ["^build"]` — silently
 * require a prior build. Testing the shared registry function directly
 * verifies the exact same resolution behavior this config spreads
 * (`...workspaceSrcAliases(...)`) without that dependency; the text
 * assertions below separately confirm the config actually spreads it and
 * does not shadow these specifiers with a stale local override.
 */
const registryEntries = workspaceSrcAliases(PACKAGES_DIR);

describe('web vite config alias contract', () => {
  it('pins the production embedding worker import to source in Vitest', () => {
    const config = readWebVitestConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/embedding-worker\/worker'[\s\S]{0,180}replacement:\s*resolve\(\s*import\.meta\.dirname,\s*'\.\.\/\.\.\/packages\/embedding-worker\/src\/embedding\.worker\.ts'\s*\)/
    );
    expect(config.indexOf("find: '@brainstrike/embedding-worker/worker'")).toBeLessThan(
      config.indexOf('...workspaceSrcAliases(')
    );
  });

  it('keeps the documented production chunk warning ceiling', () => {
    const config = readWebViteConfig();

    expect(config).toContain('chunkSizeWarningLimit: 1300');
  });

  it('filters only CSP-qualified dependency eval warnings', () => {
    const config = readWebViteConfig();

    expect(config).toContain('createCspQualifiedEvalWarningFilter,');
    expect(config).toContain('onLog: createCspQualifiedEvalWarningFilter()');
  });

  it('delegates assistant API requests to the bounded Node middleware', () => {
    const config = readWebViteConfig();

    expect(config).toMatch(/import\(\s*'\.\/src\/server\/assistant-api-middleware\.ts'\s*\)/);
    expect(config).toContain('createAssistantApiMiddleware(mode)');
    expect(config).not.toContain('const bodyStr = await readBody(req)');
  });

  it('spreads the shared workspace-src-alias registry', () => {
    expect(readWebViteConfig()).toContain('workspaceSrcAliases(');
  });

  it('resolves token-cache runtime imports to source entries via the registry', () => {
    expect(resolveThroughAliases('@brainstrike/token-cache/cache-runtime', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'token-cache/src/cache-runtime.ts')
    );
    expect(
      resolveThroughAliases('@brainstrike/token-cache/background-indexer', registryEntries)
    ).toBe(path.resolve(PACKAGES_DIR, 'token-cache/src/background-indexer.ts'));
    expect(readWebViteConfig()).not.toMatch(/find:\s*'@brainstrike\/token-cache/);
  });

  it('resolves text-splitter and tokenization subpaths from their owning packages', () => {
    for (const [specifier, packageName, sourcePath] of [
      ['@brainstrike/text-splitter/chunking-core', 'text-splitter', 'chunking-core.ts'],
      [
        '@brainstrike/tokenization/token-utils-accurate-lite',
        'tokenization',
        'token-utils-accurate-lite.ts',
      ],
      ['@brainstrike/tokenization/token-utils-lite', 'tokenization', 'token-utils-lite.ts'],
    ] as const) {
      expect(resolveThroughAliases(specifier, registryEntries)).toBe(
        path.resolve(PACKAGES_DIR, `${packageName}/src/${sourcePath}`)
      );
    }
    expect(resolveThroughAliases('@brainstrike/text-splitter', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'text-splitter/src/index.ts')
    );
    expect(readWebViteConfig()).not.toMatch(/find:\s*'@brainstrike\/text-splitter/);
    expect(readWebViteConfig()).not.toMatch(/find:\s*'@brainstrike\/tokenization/);
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    // Deliberate LOCAL override: file-tree-worker's package.json root export
    // targets a Node-worker_threads dist entry, so the registry would derive
    // that same Node-targeted src/index.ts — this app needs the
    // browser-adapted vite.ts implementation instead. Text-checked (not
    // execution-checked) since it is not registry-derived.
    const config = readWebViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-tree-worker'[\s\S]{0,120}replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
  });

  it('pins file-explorer to DIST deliberately (the ESM worker must load from a built artifact)', () => {
    // The single documented DIST exception: worker-storage.worker.mjs must
    // resolve to the emitted ESM artifact, not raw source or the CJS .js
    // artifact, for a module Worker to execute it. The registry would
    // otherwise source-alias this like every other package, so it MUST be a
    // local override placed before the spread.
    const config = readWebViteConfig();

    expect(config).toMatch(
      /find:\s*'@brainstrike\/file-explorer'[\s\S]{0,120}replacement:\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-explorer\/dist'\s*\)/
    );
    // And the registry-derived target (what it would resolve to WITHOUT the
    // override) is src, confirming this really is an override, not a no-op.
    expect(resolveThroughAliases('@brainstrike/file-explorer', registryEntries)).toBe(
      path.resolve(PACKAGES_DIR, 'file-explorer/src/index.ts')
    );

    const fileExplorerTsupConfig = readFileExplorerTsupConfig();
    expect(fileExplorerTsupConfig).toContain("'src/worker-storage.worker.js'");
    expect(fileExplorerTsupConfig).not.toContain("loader: { '.worker.js': 'copy' }");
  });

  it('aliases @brainstrike/workers explicitly (no src/ dir, registry skips it)', () => {
    const config = readWebViteConfig();

    expect(config).toMatch(/find:\s*'@brainstrike\/workers'/);
    expect(resolveThroughAliases('@brainstrike/workers', registryEntries)).toBeNull();
  });

  it('rewrites PGlite process.exitCode access in browser worker bundles', () => {
    const config = readWebViteConfig();

    expect(config).toContain(
      "const WORKER_PROCESS_EXIT_CODE_BINDING = '__brainstrikeWorkerProcessExitCode';"
    );
    expect(config).toContain("name: 'brainstrike-browser-worker-process-exit-code'");
    expect(config).toContain("code.includes('process.exitCode')");
    expect(config).toContain('code.replaceAll(');
    expect(config).toMatch(
      /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[\s*preserveWorkerEntryPlugin\(\),\s*browserWorkerProcessExitCodePlugin\(\),?\s*\]/
    );
  });

  it('co-locates the context-action/command system into one chunk (guards the built-renderer init TDZ)', () => {
    // defineContextAction/defineCommand are pure identity helpers called at
    // MODULE-INIT by feature */context-actions modules. If rolldown splits a
    // helper from its eager callers, the built renderer hits a circular
    // chunk-init TDZ ("k is not a function") and #root stays empty (dev is
    // unaffected). The single 'context-action-system' chunk removes that hazard.
    // Removing this silently re-breaks the built web app's boot — keep it pinned.
    // The helper lives in @brainstrike/build-utils (shared with desktop).
    const config = readWebViteConfig();

    expect(config).toContain('isContextActionSystemModule,');
    expect(config).toMatch(
      /isContextActionSystemModule\(moduleId\)\s*\?\s*'context-action-system'\s*:\s*null/
    );
    // No blanket vendor group: it merged lazily-imported libraries (mermaid,
    // shiki, katex, …) into eagerly-loaded chunks and put ~12 MB of JS on the
    // startup critical path. Default reachability-based splitting stays.
    expect(config).not.toContain('resolveVendorChunk');
    expect(config).not.toContain("return 'vendor'");

    // The context-action system (root + './commands' subpath) resolves to
    // SOURCE via the shared registry (same TDZ-avoidance guarantee desktop's
    // mirror test pins directly).
    const systemEntrypoints = [
      ['@brainstrike/context-actions', 'context-actions/src/index.ts'],
      ['@brainstrike/context-actions/commands', 'context-actions/src/commands/index.ts'],
    ] as const;
    for (const [specifier, sourcePath] of systemEntrypoints) {
      const resolved = resolveThroughAliases(specifier, registryEntries);
      expect(resolved).toBe(path.resolve(PACKAGES_DIR, sourcePath));
      expect(resolved).not.toMatch(/dist/);
    }
  });
});
