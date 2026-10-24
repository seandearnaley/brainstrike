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
 *
 * This repo's "Unit"/"Unit (heavy)" CI lanes deliberately run with NO
 * standalone build step (test.yml's B4 rationale: "tests no longer need
 * `dist` to exist... a regression here fails LOUDLY on the always-clean CI
 * runner instead of passing against stale dist") — workspace `dist/`
 * directories genuinely do not exist there, by design, not as a bug. A bare
 * `require.resolve` failure for an entirely-missing `dist/` file
 * (`MODULE_NOT_FOUND`) is therefore expected and NOT this guard's concern;
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` (the exports-map-exists-but-wrong-
 * condition shape that broke Desktop E2E) is. When dist IS present — a
 * local dev loop after `pnpm build`, or any CI lane that downloads/builds
 * artifacts first, e.g. Desktop E2E — this still catches the real bug
 * class; it degrades gracefully rather than requiring dist to always exist,
 * because that is not this monorepo's contract for the plain unit-test lane.
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

function isMissingDistError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
}

describe('main-process bundle external requires (real Electron-main CJS resolution)', () => {
  it('resolves every @brainstrike/* import the bundle leaves external, when built', async () => {
    const specifiers = await collectExternalWorkspaceImports();
    // A regression in entry-point wiring should never silently shrink this to
    // zero and pass — the whole point is exercising real resolution.
    expect(specifiers.length).toBeGreaterThan(0);

    const exportsMapFailures: { error: string; specifier: string }[] = [];
    let builtCount = 0;
    for (const specifier of specifiers) {
      try {
        require.resolve(specifier, { paths: [path.resolve(import.meta.dirname, '../..')] });
        builtCount += 1;
      } catch (error) {
        if (isMissingDistError(error)) {
          continue;
        }
        // Anything other than "the dist file plain doesn't exist" —
        // ERR_PACKAGE_PATH_NOT_EXPORTED chief among them — is the real bug
        // class this test exists to catch, in any environment.
        exportsMapFailures.push({ error: String(error), specifier });
      }
    }
    if (builtCount === 0 && exportsMapFailures.length === 0) {
      // Nothing in this run had a built dist to resolve against at all —
      // exactly this repo's documented no-build Unit-lane state. Nothing
      // meaningful was exercised; that is expected here, not a failure.
      // eslint-disable-next-line no-console
      console.info(
        `[main-process-bundle-external-requires] Skipped: no built dist/ found for any of ${specifiers.length} workspace imports (expected in this repo's no-build Unit test lanes).`
      );
    }
    expect(exportsMapFailures).toEqual([]);
  });
});
