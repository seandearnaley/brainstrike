import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readWebViteConfig(): string {
  return readFileSync(path.resolve(process.cwd(), 'vite.config.mts'), 'utf8');
}

describe('web vite config alias contract', () => {
  it('pins the turso wasm runtime graph via the shared alias map (Vercel worker sub-build + emnapi contract)', () => {
    // The production web bundle must resolve the SAME @emnapi/* +
    // @tybys/wasm-util graph the packages/db vitest browser project proves:
    // @emnapi/core >= 1.10 deterministically faults turso's wasm store open,
    // and the vite:worker-import-meta-url sub-build for database-wasm's
    // worker failed to resolve the bare '@tybys/wasm-util' import from the
    // pnpm store on Vercel. Both are pinned by the shared alias module.
    const config = readWebViteConfig();
    expect(config).toContain(
      "import { createTursoWasmRuntimeAliasMap } from '../../packages/db/config/turso-wasm-runtime-aliases.mjs'"
    );
    expect(config).toMatch(
      /alias:\s*{[\s\S]*\.\.\.createTursoWasmRuntimeAliasMap\(path\.resolve\(__dirname, '\.\.\/\.\.\/packages\/db'\)\)/
    );
  });

  it('pins token-cache runtime imports to source entries', () => {
    const config = readWebViteConfig();

    expect(config).toContain("'@brainstrike/token-cache/cache-runtime': path.resolve(");
    expect(config).toContain('../../packages/token-cache/src/cache-runtime.ts');
    expect(config).toContain("'@brainstrike/token-cache/background-indexer': path.resolve(");
    expect(config).toContain('../../packages/token-cache/src/background-indexer.ts');
  });

  it('pins selection-rules to the workspace source entry', () => {
    const config = readWebViteConfig();

    expect(config).toContain("'@brainstrike/selection-rules': path.resolve(");
    expect(config).toContain('../../packages/selection-rules/src/index.ts');
  });

  it('pins text-splitter subpath imports before the root source alias', () => {
    const config = readWebViteConfig();
    const rootAliasIndex = config.indexOf("'@brainstrike/text-splitter': path.resolve(");

    for (const [specifier, sourcePath] of [
      ['@brainstrike/text-splitter/chunking-core', 'chunking-core.ts'],
      ['@brainstrike/text-splitter/token-counting-heuristics', 'token-counting-heuristics.ts'],
      ['@brainstrike/text-splitter/token-constants', 'token-constants.ts'],
      ['@brainstrike/text-splitter/token-utils-accurate-lite', 'token-utils-accurate-lite.ts'],
    ] as const) {
      const aliasIndex = config.indexOf(`'${specifier}': path.resolve(`);
      expect(aliasIndex).toBeGreaterThanOrEqual(0);
      expect(aliasIndex).toBeLessThan(rootAliasIndex);
      expect(config).toContain(`../../packages/text-splitter/src/${sourcePath}`);
    }
  });

  it('pins file-tree-worker to source so renderer dev does not load stale dist workers', () => {
    const config = readWebViteConfig();

    expect(config).toMatch(
      /'@brainstrike\/file-tree-worker':\s*path\.resolve\(\s*__dirname,\s*'\.\.\/\.\.\/packages\/file-tree-worker\/src\/vite\.ts'\s*\)/
    );
    expect(config).not.toContain('../../packages/file-tree-worker/dist');
    expect(config).toContain("'@brainstrike/file-tree-worker'");
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
      /worker:\s*\{\s*format:\s*'es',\s*plugins:\s*\(\)\s*=>\s*\[browserWorkerProcessExitCodePlugin\(\)\]/
    );
  });

  it('co-locates the context-action/command system into one chunk (guards the built-renderer init TDZ)', () => {
    // defineContextAction/defineCommand are pure identity helpers called at
    // MODULE-INIT by feature */context-actions modules. If rolldown splits a
    // helper from its eager callers, the built renderer hits a circular
    // chunk-init TDZ ("k is not a function") and #root stays empty (dev is
    // unaffected). The single 'context-action-system' chunk removes that hazard.
    // Removing this silently re-breaks the built web app's boot — keep it pinned.
    const config = readWebViteConfig();

    expect(config).toContain('function isContextActionSystemModule(');
    expect(config).toContain("return 'context-action-system';");
    // The namer must run the co-location check BEFORE vendor chunking.
    const coLocationIndex = config.indexOf('isContextActionSystemModule(moduleId)');
    const vendorFallbackIndex = config.indexOf('resolveVendorChunk(moduleId) ?? null');
    expect(coLocationIndex).toBeGreaterThanOrEqual(0);
    expect(vendorFallbackIndex).toBeGreaterThan(coLocationIndex);
  });
});
