import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
} from '../../scripts/build-main-config.mjs';

/**
 * Contract for the bundled main-process build (Electron performance checklist
 * recipe 7: "Bundle your code"). The runtime resolves these outputs by exact
 * path, so the entry list and output layout must stay pinned:
 * - package.json "main" → dist/main.js
 * - BrowserWindow preload → dist/preload.js (visible window AND hidden hosts)
 * - utilityProcess.fork sibling lookups → dist/db-host-entry.js,
 *   dist/parser-host-entry.js (resolved relative to module.filename of the
 *   bundled main.js, so outputs must stay FLAT in dist/)
 */
describe('main-process bundle config', () => {
  it('bundles exactly the four runtime entry points', () => {
    expect(MAIN_PROCESS_ENTRY_POINTS).toEqual([
      'src/main.ts',
      'src/preload.ts',
      'src/db-host-entry.ts',
      'src/parser-host-entry.ts',
    ]);
  });

  it('bundles app code only, as flat CJS for the Electron main process', () => {
    expect(MAIN_PROCESS_BUILD_OPTIONS.bundle).toBe(true);
    expect(MAIN_PROCESS_BUILD_OPTIONS.format).toBe('cjs');
    expect(MAIN_PROCESS_BUILD_OPTIONS.platform).toBe('node');
    // Bare imports (electron, node-pty, @brainstrike/* dist packages, every
    // node_modules dep) must stay external requires — bundling them would
    // change runtime resolution (native modules, agent-client-loader's
    // require.resolve probing) and duplicate prebuilt workspace bundles.
    expect(MAIN_PROCESS_BUILD_OPTIONS.packages).toBe('external');
    // Flat output directory keeps the fork-entry sibling lookups valid.
    expect(MAIN_PROCESS_BUILD_OPTIONS.outdir?.endsWith('dist')).toBe(true);
    expect(MAIN_PROCESS_BUILD_OPTIONS.outbase?.endsWith('src')).toBe(true);
  });

  it('ignores the renderer tsconfig paths so workspace packages stay external', () => {
    // apps/desktop/tsconfig.json maps @brainstrike/* to SOURCE for the vite
    // renderer. esbuild auto-applies the nearest tsconfig's paths, which would
    // inline workspace package sources into the bundle and leak their own
    // dependencies as unresolvable requires (e.g. @brainstrike/indexing-contract
    // is not a dependency of @brainstrike/desktop — it crashed app launch).
    // An empty tsconfigRaw disables paths resolution for the bundle.
    expect(MAIN_PROCESS_BUILD_OPTIONS.tsconfigRaw).toBe('{}');
  });

  it('inlines @brainstrike/notes-vault/core from source (sole packages-external exception)', () => {
    // The notes-vault dist is bundler-target ESM with extensionless relative
    // imports — Node's runtime resolver cannot require() it from the CJS main
    // bundle, so this ONE subpath is aliased to source and bundled. Dropping
    // the alias would crash app launch on the welcome-note constants import
    // in notes-vault-ipc-handlers.ts.
    const aliases = MAIN_PROCESS_BUILD_OPTIONS.alias as Record<string, string>;
    expect(Object.keys(aliases)).toEqual(['@brainstrike/notes-vault/core']);
    expect(
      aliases['@brainstrike/notes-vault/core']?.endsWith(
        path.join('packages', 'notes-vault', 'src', 'core', 'index.ts')
      )
    ).toBe(true);
  });
});
