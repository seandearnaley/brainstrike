import path from 'node:path';
import { app } from 'electron';
import { resolveBundledDistDir } from '../bundled-sibling-path';
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
  // itself — a sibling of dist/, not of main.js — so this needs the dist/
  // directory, not a same-directory sibling file.
  const distDir = resolveBundledDistDir('Python runtime', currentModuleFilename);
  // This resolver additionally depends on dist/'s DEPTH below the app root
  // (one MORE dirname() below, past what resolveBundledDistDir already
  // does — see build-main-config.mjs), which is strictly more fragile than
  // the sibling-of-main.js pattern the watchdog and log-transport resolvers
  // use: they only need "same directory as the running module" and are
  // unaffected if dist/ ever moves. Enforce the depth assumption at runtime
  // instead of leaving it documented-but-silent (PR #2680 review) — a
  // wrong-but-well-formed path here degrades invisibly (the manifest probe
  // just reports "not installed"), so this must fail loudly the moment
  // dist/ nesting changes, not quietly point at the wrong directory.
  if (path.basename(distDir) !== 'dist') {
    throw new Error(
      `Python runtime: expected the running main module to live in dist/, received "${distDir}"`
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
