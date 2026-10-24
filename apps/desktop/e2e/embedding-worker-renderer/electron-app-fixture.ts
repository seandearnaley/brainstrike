import net from 'node:net';
import type { Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { resolveDesktopDevRendererConfig } from '../../src/desktop-renderer-config';
import { loadElectronHelpers } from '../utils/load-electron-helpers';

export { default as os } from 'node:os';
export { default as path } from 'node:path';
export type { Locator, Page } from '@playwright/test';
export type { ElectronApplication } from 'playwright';
export { expect, test } from '../fixtures/electron-fixture';

const desktopDevRendererConfig = resolveDesktopDevRendererConfig(
  process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL']
);
if (desktopDevRendererConfig.kind === 'invalid-override') {
  throw new Error(
    `Invalid BRAINSTRIKE_DESKTOP_DEV_SERVER_URL override: ${desktopDevRendererConfig.configuredUrl}`
  );
}

export const DESKTOP_DEV_RENDERER_PORT = desktopDevRendererConfig.port;
export const DESKTOP_DEV_RENDERER_URL = desktopDevRendererConfig.url;

export async function getBufferedElectronOutputInTest(
  app: ElectronApplication
): Promise<{ stderr: string[]; stdout: string[] }> {
  const { getBufferedElectronOutput } = await loadElectronHelpers();
  return await getBufferedElectronOutput(app);
}

export async function launchElectronDevAppInTest(userDataDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
}> {
  const { launchElectronAppWithOptions } = await loadElectronHelpers();
  return await launchElectronAppWithOptions({
    launchMode: 'dev-server',
    userDataDir,
  });
}

export async function closeElectronAppInTest(app: {
  app: ElectronApplication;
  window: Page;
}): Promise<void> {
  const { closeElectronApp } = await loadElectronHelpers();
  await closeElectronApp(app);
}

export async function reloadRendererInTest(page: Page, reason: string): Promise<void> {
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reason);
}

export async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

export function isDisposedElectronEvaluateError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes('Execution context was destroyed') ||
      error.message.includes('Target page, context or browser has been closed'))
  );
}

export function withTemporaryProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function waitForTcpPortOpen(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const hosts = ['127.0.0.1', '::1'] as const;
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await Promise.any(
      hosts.map(
        (host) =>
          new Promise<boolean>((resolve, reject) => {
            const socket = net.createConnection({ host, port }, () => {
              socket.destroy();
              resolve(true);
            });
            socket.on('error', () => {
              socket.destroy();
              reject(new Error(`connect failed for ${host}:${port}`));
            });
          })
      )
    )
      .then(() => true)
      .catch(() => false);
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for localhost:${port} to accept connections.`);
}
