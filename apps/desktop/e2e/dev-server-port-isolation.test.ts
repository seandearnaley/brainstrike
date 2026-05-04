import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const LEGACY_WEB_ADJACENT_PORT = 8081;
const DESKTOP_APP_ROOT = process.cwd();

function waitForTcpPortOpen(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  return new Promise<void>((resolve, reject) => {
    const attemptConnection = (): void => {
      const socket = net.connect({ host: 'localhost', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for TCP port ${port} to open.`));
          return;
        }
        setTimeout(attemptConnection, 200);
      });
    };

    attemptConnection();
  });
}

function startDesktopRendererDevServer(devServerUrl: string): ChildProcess {
  return spawn('pnpm', ['dev:renderer'], {
    cwd: DESKTOP_APP_ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      BRAINSTRIKE_DESKTOP_DEV_SERVER_URL: devServerUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    child.kill('SIGTERM');
  } else if (typeof child.pid === 'number') {
    process.kill(-child.pid, 'SIGTERM');
  }

  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(resolve, 5000);
  });
}

function createOutputBuffer(child: ChildProcess): {
  readonly stderr: string[];
  readonly stdout: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout.push(String(chunk));
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr.push(String(chunk));
  });

  return { stdout, stderr };
}

async function waitForRendererServerReady(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  output: { readonly stderr: string[]; readonly stdout: string[] }
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop renderer dev server exited before opening port ${port}.\nstdout=${output.stdout.join('')}\nstderr=${output.stderr.join('')}`
      );
    }

    try {
      await waitForTcpPortOpen(port, 500);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(
    `Timed out waiting for TCP port ${port} to open.\nstdout=${output.stdout.join('')}\nstderr=${output.stderr.join('')}`
  );
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('Desktop dev-server port isolation', () => {
  test('launches the desktop dev app even when the legacy web-adjacent port is occupied', async () => {
    const originalDevServerUrl = process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'];
    const isolatedPort = 39_000 + Math.floor(Math.random() * 1000);
    const isolatedDevServerUrl = `http://localhost:${isolatedPort}`;
    const { closeElectronApp, launchElectronAppWithOptions } = await loadElectronHelpers();
    const legacyPortServer = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('legacy-port-occupied');
    });
    const rendererServer = startDesktopRendererDevServer(isolatedDevServerUrl);
    const rendererServerOutput = createOutputBuffer(rendererServer);
    let electronContext: Awaited<ReturnType<typeof launchElectronAppWithOptions>> | undefined;

    process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = isolatedDevServerUrl;

    try {
      await listen(legacyPortServer, LEGACY_WEB_ADJACENT_PORT);
      await waitForRendererServerReady(rendererServer, isolatedPort, 30_000, rendererServerOutput);

      electronContext = await launchElectronAppWithOptions({
        launchMode: 'dev-server',
        userDataDir: path.join(os.tmpdir(), `brainstrike-dev-server-port-${process.pid}`),
      });

      const homePage = new HomePage(electronContext.window);
      await homePage.shouldBeVisible();
      await expect(electronContext.window).toHaveURL(new RegExp(`^${isolatedDevServerUrl}`));
      await expect(electronContext.window).toHaveTitle(/BrainStrike/i);
      await expect(electronContext.window.getByTestId('desktop-startup-failure')).toHaveCount(0);
    } finally {
      if (originalDevServerUrl === undefined) {
        Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DESKTOP_DEV_SERVER_URL');
      } else {
        process.env['BRAINSTRIKE_DESKTOP_DEV_SERVER_URL'] = originalDevServerUrl;
      }
      if (electronContext) {
        await closeElectronApp(electronContext);
      }
      await closeServer(legacyPortServer);
      await stopChildProcess(rendererServer);
    }
  });
});
