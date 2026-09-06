// @vitest-environment node
/**
 * Regression guard for a review finding (BST-1393, PR #2679): a prior version
 * of `workspace-recent-roots.ts` loaded its refusal-message constants via a
 * dynamic `import()` of an app-shell subpath. Vitest resolves that subpath
 * from SOURCE through Vite's own resolver, so every existing test stayed
 * green even though the mechanism had a real (if non-fatal — verified
 * empirically before this fix) production wrinkle: Electron main is bundled
 * as CJS, and the app-shell subpath in question only publishes an ESM
 * `"import"` condition.
 *
 * That mechanism was reverted back to local literal constants (see the doc
 * comment on `NEVER_GRANTED_MESSAGE` in `workspace-recent-roots.ts`), so
 * there is nothing left to break — but this test exists so that if anyone
 * ever reintroduces a cross-package runtime import in this file, THIS test
 * (which compiles the file with the real production esbuild settings and
 * executes the actual compiled output, not a vitest-resolved import) would
 * surface a resolution failure the ordinary vitest-context tests cannot see.
 *
 * Needs the real `node` test environment: esbuild's own invariant check
 * (`new TextEncoder().encode("") instanceof Uint8Array`) fails under this
 * package's default jsdom, exactly as documented in the sibling
 * `main-process-bundle-external-requires.test.ts`, which this file mirrors.
 *
 * Same CI-lane caveat as that sibling: this repo's Unit lanes deliberately
 * run with no standalone build step, so a workspace package's `dist/`
 * (`@brainstrike/file-system`, `@brainstrike/logging` — both real runtime
 * imports in `workspace-recent-roots.ts`) may not exist there. A
 * `MODULE_NOT_FOUND` while loading the compiled artifact is that expected,
 * environment-dependent case, not this guard's concern — it is reported and
 * skipped rather than failed. Any OTHER load error (a real bug this test
 * exists to catch) still fails loudly.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as esbuildTypes from 'esbuild';
import esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import type { resolveGrantedRootHandle as ResolveGrantedRootHandleType } from '../ipc-domains/workspace-recent-roots';
import { createStorage } from './ipc-domains/workspace-root-registry-test-helpers';

// apps/desktop/src/__tests__ -> apps/desktop (two levels up), the directory
// containing apps/desktop/package.json — needed so createRequire below
// resolves @brainstrike/* deps through the SAME node_modules chain the real
// bundled dist/main.js would.
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface CompiledWorkspaceRecentRootsModule {
  readonly resolveGrantedRootHandle: typeof ResolveGrantedRootHandleType;
}

function isMissingDistError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
}

describe('workspace-recent-roots.ts compiled with the real production bundle settings', () => {
  let outDir: string;
  let compiled: CompiledWorkspaceRecentRootsModule | null = null;

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'workspace-recent-roots-build-artifact-'));
    // build-main-config.mjs is plain JS (no esbuild import, deliberately —
    // see build-main-config.test.ts's header comment), so its exported
    // config widens to plain string/boolean fields; re-assert esbuild's own
    // BuildOptions shape here, mirroring main-process-bundle-external-requires.test.ts.
    const buildOptions: esbuildTypes.BuildOptions = {
      ...(MAIN_PROCESS_BUILD_OPTIONS as Omit<esbuildTypes.BuildOptions, 'entryPoints'>),
      // Isolate this one file rather than the whole app's entry-point map —
      // same format/packages-external/platform/target/tsconfigRaw contract
      // MAIN_PROCESS_BUILD_OPTIONS pins for the real dist/main.js, just
      // scoped to what this test needs to exercise.
      entryPoints: { 'workspace-recent-roots': 'src/ipc-domains/workspace-recent-roots.ts' },
      logLevel: 'silent',
      outdir: outDir,
      write: true,
    };
    const result = await esbuild.build(buildOptions);
    if (result.errors.length > 0) {
      throw new Error(`esbuild reported errors: ${JSON.stringify(result.errors)}`);
    }
    const compiledModulePath = path.join(outDir, 'workspace-recent-roots.js');
    // require(), not import: MAIN_PROCESS_BUILD_OPTIONS pins format: 'cjs' —
    // this is exactly what the real dist/main.js is, and how it's loaded.
    const requireFromDesktop = createRequire(path.join(desktopRoot, 'package.json'));
    try {
      compiled = requireFromDesktop(compiledModulePath) as CompiledWorkspaceRecentRootsModule;
    } catch (error) {
      if (!isMissingDistError(error)) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.info(
        "[workspace-recent-roots-build-artifact] Skipped: a dependency dist/ was not built in this lane (expected in this repo's no-build Unit test lanes)."
      );
    }
  }, 30_000);

  afterAll(async () => {
    await rm(outDir, { force: true, recursive: true });
  });

  it('throws the canonical never-granted message when driven through the REAL compiled artifact', async () => {
    if (!compiled) {
      return;
    }
    await expect(
      compiled.resolveGrantedRootHandle(createStorage(), '/somewhere/never-granted')
    ).rejects.toMatchObject({
      message: 'Folder was never granted in this app; use Add Folder to grant it.',
    });
  });

  it('throws the canonical managed-but-unauthorized message when the authorizer declines', async () => {
    if (!compiled) {
      return;
    }
    await expect(
      compiled.resolveGrantedRootHandle(createStorage(), '/managed/app/not-a-row', () =>
        Promise.resolve('managed-but-unauthorized')
      )
    ).rejects.toMatchObject({
      message:
        'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.',
    });
  });
});
