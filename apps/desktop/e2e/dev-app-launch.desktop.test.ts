import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer } from 'vite';
import { launchElectronAppWithOptions } from './utils/electron-helpers.mts';

// Regression: the renderer's Send schema imported the native indexer through
// platform-wire. Production tree shaking hid its node:v8 import; dev evaluated it.
test('dev renderer opens and reloads through the unbundled Send configuration', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'bs-dev-launch-'));
  let joined = false;
  const server = await createServer({
    configFile: path.resolve('vite.config.mts'),
    server: { host: '127.0.0.1' },
  });
  try {
    await server.listen();
    const context = await launchElectronAppWithOptions({
      disableExternalLocalRuntimeProbes: true,
      launchMode: 'dev-server',
      userDataDir: profile,
    });
    const child = context.app.process();
    try {
      const errors: string[] = [];
      context.window.on('pageerror', (error) => errors.push(error.message));
      await expect(context.window.getByTestId('new-agent-button')).toBeVisible();
      await context.window.reload();
      await expect(context.window.getByTestId('new-agent-button')).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.app.close();
      joined = true;
      expect(child.exitCode).toBe(0);
    }
  } finally {
    await server.close();
    if (joined) {
      await rm(profile, { force: true, recursive: true });
    }
  }
});
