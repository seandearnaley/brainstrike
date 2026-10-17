import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  closePackagedDesktop,
  launchPackagedDesktop,
  packagedDesktopExecutablePath,
} from './utils/packaged-electron';

test('settings and encrypted OAuth records persist across packaged reopen and clear @packaged @destructive', async () => {
  // Three fresh processes share the existing packaged lifecycle lane's total budget.
  test.setTimeout(360_000);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-settings-packaged-'));
  const windowState = {
    v1: {
      bounds: { height: 720, width: 1080, x: 30, y: 40 },
      isFullScreen: false,
      isMaximized: false,
    },
  };
  const fakeToken = 'disposable-settings-qualification-token';
  try {
    // Keep this persistence fixture independent of a cold background unpack.
    // Windows packages intentionally contain no bundled Python runtime.
    if (process.platform !== 'win32') {
      const { resolvePythonBinary } = await import('../src/python-runtime/resolve-python-binary');
      const executableDirectory = path.dirname(packagedDesktopExecutablePath());
      const resourcesPath =
        process.platform === 'darwin'
          ? path.resolve(executableDirectory, '..', 'Resources')
          : path.join(executableDirectory, 'resources');
      await resolvePythonBinary({
        resourcesDir: path.join(resourcesPath, 'python-runtime'),
        signal: AbortSignal.timeout(60_000),
        userDataDir,
      });
    }
    for (const phase of ['write', 'reopen-and-clear', 'reopen-cleared'] as const) {
      const context = await launchPackagedDesktop({ userDataDir });
      try {
        const result = await context.app.evaluate(
          async ({ app, safeStorage }, input) => {
            const { createRequire } = process.getBuiltinModule('node:module');
            const fromApp = createRequire(`${app.getAppPath()}/package.json`);
            const { default: Store } = fromApp('electron-store') as typeof import('electron-store');
            const settings = new Store({ name: 'brainstrike-settings' });
            const oauth = new Store({ name: 'brainstrike-mcp-oauth' });
            if (input.phase === 'write') {
              if (!(await safeStorage.isAsyncEncryptionAvailable())) {
                throw new Error('Packaged settings proof requires OS-backed encryption');
              }
              if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
                throw new Error('Packaged settings proof refuses basic_text encryption');
              }
              settings.set('qualificationWindowState', input.windowState);
              oauth.set('records', {
                qualification: (await safeStorage.encryptStringAsync(input.fakeToken)).toString(
                  'base64'
                ),
              });
              return { phase: input.phase };
            }
            const windowState = settings.get('qualificationWindowState');
            const records = oauth.get('records') as { qualification?: string } | undefined;
            let token: string | undefined;
            if (records?.qualification) {
              token = (
                await safeStorage.decryptStringAsync(Buffer.from(records.qualification, 'base64'))
              ).result;
            }
            if (input.phase === 'reopen-and-clear') {
              settings.clear();
              oauth.set('records', {});
            }
            return { phase: input.phase, records, token, windowState };
          },
          { fakeToken, phase, windowState }
        );
        if (phase === 'reopen-and-clear') {
          expect(result).toMatchObject({ token: fakeToken, windowState });
        }
        if (phase === 'reopen-cleared') {
          expect(result).toMatchObject({ records: {}, token: undefined, windowState: undefined });
        }
      } finally {
        await closePackagedDesktop(context);
      }
    }
  } finally {
    await rm(userDataDir, { force: true, recursive: true });
  }
});
