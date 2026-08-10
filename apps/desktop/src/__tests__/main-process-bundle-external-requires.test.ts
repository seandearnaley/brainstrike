// @vitest-environment node
/**
 * Guards against the class of bug that broke Desktop E2E on BST-1200 M2:
 * a source file reachable from an Electron main-process entry point importing
 * a workspace package whose `exports` map has no `require` condition.
 * `MAIN_PROCESS_BUILD_OPTIONS.packages === 'external'` (pinned in
 * build-main-config.test.ts) means every `@brainstrike/*` import stays a bare
 * `require(...)` in the bundled CJS output — Vitest never catches this class
 * because it resolves TypeScript SOURCES directly, never the package's
 * `exports` map, so a package that type-checks and unit-tests cleanly can
 * still crash real Electron main on launch. Only a real (write:false)
 * esbuild bundle of the real entry points — the same config and entry list
 * the production build uses, aliases included — followed by Node's own CJS
 * `require.resolve` on every import esbuild left external, proves the
 * exports maps actually work for this consumer.
 *
 * Kept as its own file (not appended to build-main-config.test.ts) because
 * that file deliberately stays esbuild-free and cheap; this one pays the
 * cost of a real bundle. esbuild needs the real `node` test environment —
 * it does not run under this package's default jsdom (jsdom's `TextEncoder`
 * output fails esbuild's `instanceof Uint8Array` invariant check) — so the
 * shared setup.ts guards its `window`-dependent mocks accordingly.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  MAIN_PROCESS_BUILD_OPTIONS,
  MAIN_PROCESS_ENTRY_POINTS,
} from '../../scripts/build-main-config.mjs';

const require = createRequire(import.meta.url);

/** Every bare `@brainstrike/*` import specifier esbuild left external while bundling the real main-process entry points, deduped. */
async function collectExternalWorkspaceImports(): Promise<readonly string[]> {
  // build-main-config.mjs is plain JS (no esbuild import, deliberately — see
  // build-main-config.test.ts's header comment), so its exported config
  // widens to plain `string`/`boolean` fields; re-assert esbuild's own
  // BuildOptions shape here rather than typing the shared config module
  // against esbuild.
  const buildOptions: esbuild.BuildOptions = {
    ...(MAIN_PROCESS_BUILD_OPTIONS as Omit<esbuild.BuildOptions, 'entryPoints'>),
    entryPoints: MAIN_PROCESS_ENTRY_POINTS,
    logLevel: 'silent',
    metafile: true,
    write: false,
  };
  const result = await esbuild.build(buildOptions);
  const specifiers = new Set<string>();
  for (const input of Object.values(result.metafile?.inputs ?? {})) {
    for (const imp of input.imports) {
      if (imp.external && imp.path.startsWith('@brainstrike/')) {
        specifiers.add(imp.path);
      }
    }
  }
  return [...specifiers].sort();
}

describe('main-process bundle external requires (real Electron-main CJS resolution)', () => {
  it('resolves every @brainstrike/* import the bundle leaves external', async () => {
    const specifiers = await collectExternalWorkspaceImports();
    // A regression in entry-point wiring should never silently shrink this to
    // zero and pass — the whole point is exercising real resolution.
    expect(specifiers.length).toBeGreaterThan(0);

    const unresolved: { error: string; specifier: string }[] = [];
    for (const specifier of specifiers) {
      // agent-client-loader.ts's `resolveAgentPackageRoot` deliberately
      // probes `@brainstrike/agent/package.json` in a try/catch that already
      // tolerates ERR_PACKAGE_PATH_NOT_EXPORTED — a `package.json` subpath is
      // an optional existence probe by design, not a load-bearing require.
      if (specifier.endsWith('/package.json')) {
        continue;
      }
      try {
        require.resolve(specifier, { paths: [path.resolve(import.meta.dirname, '../..')] });
      } catch (error) {
        unresolved.push({ error: String(error), specifier });
      }
    }
    expect(unresolved).toEqual([]);
  });
});
