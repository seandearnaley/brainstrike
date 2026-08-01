import path from 'node:path';
import { app } from 'electron';
import { resolvePythonBinary } from './resolve-python-binary';

export * from './resolve-python-binary';

function desktopPythonRuntimeResourcesDir(): string {
  // Packaged: electron-builder's extraResources copies
  // resources/python-runtime/ to <Resources>/python-runtime. Dev/unpacked:
  // the fetched tarballs live in the repo's apps/desktop/resources/.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'python-runtime')
    : path.join(app.getAppPath(), 'resources', 'python-runtime');
}

/**
 * The desktop composition root's bundled-CPython capability (BST-1061):
 * resolve once, then INJECT the resulting absolute path wherever an
 * interpreter is needed (`FenceExecutor` takes it as `FenceInterpreter` —
 * it never imports this module). The unpack dir lives under
 * `app.getPath('userData')`, so factory reset's wholesale userData wipe
 * covers it with no extra wiring.
 */
export function resolveDesktopPythonExecutable(): Promise<string> {
  return resolvePythonBinary({
    resourcesDir: desktopPythonRuntimeResourcesDir(),
    userDataDir: app.getPath('userData'),
  });
}
