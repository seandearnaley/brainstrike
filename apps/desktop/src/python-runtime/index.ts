import { app } from 'electron';
import { resolvePythonBinary } from './resolve-python-binary';
import { resolveDesktopPythonRuntimeResourcesDir } from './resources-dir';

export * from './resolve-python-binary';
export { resolveDesktopPythonRuntimeResourcesDir } from './resources-dir';

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
