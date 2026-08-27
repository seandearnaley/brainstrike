import path from 'node:path';
import { app } from 'electron';
import { resolveBundledModuleDir } from '../bundled-sibling-path';
import { resolvePythonBinary } from './resolve-python-binary';

export * from './resolve-python-binary';

export function resolveDesktopPythonRuntimeResourcesDir(
  isPackaged: boolean,
  resourcesPath: string,
  currentModuleFilename?: string
): string {
  // Packaged: electron-builder's extraResources copies
  // resources/python-runtime/ to <Resources>/python-runtime.
  if (isPackaged) {
    return path.join(resourcesPath, 'python-runtime');
  }

  // BST-1459: see bundled-sibling-path.ts for the full launch-mode rationale
  // and NO SILENT FALLBACKS reasoning (PR #2680 review). Development
  // resources are rooted in dist/'s PARENT (apps/desktop/), not dist/
  // itself — a sibling of dist/, not of main.js — so this needs the running
  // module's own parent directory (dist/ itself), not a same-directory
  // sibling file. The guard below stays HERE, not inside the shared helper
  // (PR #2680 delta re-review): the helper's own unit test calls it with
  // the real __filename, which resolves to src/ under Vitest — an in-helper
  // identity check would fail immediately for every other caller.
  const distDir = resolveBundledModuleDir('Python runtime', currentModuleFilename);
  // This resolver additionally depends on the running module's immediate
  // parent directory being literally NAMED "dist" — an IDENTITY check on
  // that one path segment, not a depth check (PR #2680 delta re-review
  // corrected this framing: e.g. out/dist/main.js still PASSES this guard,
  // since only the parent's basename is compared, not how many levels it
  // sits below the app root). The watchdog and log-transport resolvers
  // don't need this at all — they only need "same directory as the running
  // module," whatever that directory happens to be named. Enforce the
  // identity assumption at runtime instead of leaving it
  // documented-but-silent (PR #2680 review) — a wrong-but-well-formed path
  // here degrades invisibly (the manifest probe just reports "not
  // installed"), so this must fail loudly if the bundle output is ever
  // restructured to not use a literal dist/ directory, not quietly point at
  // the wrong directory.
  if (path.basename(distDir) !== 'dist') {
    throw new Error(
      `Python runtime: expected the running main module's parent directory to be named "dist", received "${distDir}"`
    );
  }
  return path.join(path.dirname(distDir), 'resources', 'python-runtime');
}

function desktopPythonRuntimeResourcesDir(): string {
  return resolveDesktopPythonRuntimeResourcesDir(app.isPackaged, process.resourcesPath);
}

/**
 * The desktop composition root's bundled-CPython capability (BST-1061):
 * resolve once, then INJECT the resulting absolute path wherever an
 * interpreter is needed (`FenceExecutor` takes it as `FenceInterpreter` —
 * it never imports this module). The unpack dir lives under
 * `app.getPath('userData')`, so factory reset's wholesale userData wipe
 * covers it with no extra wiring.
 *
 * `signal` is forwarded straight through to `resolvePythonBinary` (PR #2205
 * review): a run_skill_script user Stop, or a caller's own timeout budget,
 * must be able to interrupt a cold first-run unpack, not just the process
 * spawned afterward.
 */
export function resolveDesktopPythonExecutable(signal?: AbortSignal): Promise<string> {
  return resolvePythonBinary({
    resourcesDir: desktopPythonRuntimeResourcesDir(),
    signal,
    userDataDir: app.getPath('userData'),
  });
}
