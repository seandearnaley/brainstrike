import { createLogger } from '@brainstrike/logging';
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

const logger = createLogger('DesktopPythonRuntime');

/**
 * Best-effort warm-up for the bundled-CPython capability (BST-1061): unpacking
 * the ~250MB CPython tree is the only slow part of resolving it. Doing it once
 * at boot means the first real `python3` skill script, which the agent host
 * resolves under the same userData directory, almost always hits the cheap
 * already-unpacked path. A PERFORMANCE optimization, not a correctness
 * dependency: the skill-script tool bounds a cold resolve by its own timeout and
 * Stop. Failure is logged, never thrown — an unsupported platform or a dev
 * checkout without `fetch:python-runtime` must not block boot.
 */
export function warmDesktopPythonRuntime(): void {
  const logWarmupFailure = (error: unknown) => {
    logger.warn(
      'Bundled Python runtime warm-up failed; the first python3 skill script will pay for it',
      { error: error instanceof Error ? error.message : String(error) }
    );
  };
  try {
    resolveDesktopPythonExecutable().catch(logWarmupFailure);
  } catch (error) {
    // resolveDesktopPythonExecutable's synchronous prelude reads `app` paths
    // before it returns a Promise; a `.catch()` alone cannot see that throw.
    logWarmupFailure(error);
  }
}
