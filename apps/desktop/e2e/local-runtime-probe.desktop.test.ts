/**
 * End-to-end integration test for the main-process probe bridge.
 *
 * This test addresses a user bug report: "ran the desktop app with Ollama
 * running locally and the probe didn't find it." The root cause was CORS —
 * Chromium in the renderer enforces Ollama's OLLAMA_ORIGINS allow-list,
 * which does not include Electron's file:// / app:// origin. The fix runs
 * probes in the main process over IPC (apps/desktop/src/ipc-runtime.ts).
 *
 * Strategy: stand up a real HTTP server on 127.0.0.1:11434 that mimics the
 * two canonical Ollama responses (/api/tags + /api/version), boot the
 * desktop app, open Settings → Local Runtimes, and assert the Ollama card
 * reports Available. If the main-process bridge regresses, this test fails
 * where a renderer-only probe would succeed under a permissive CORS mock.
 */

import http from 'node:http';
import { expect, test } from './fixtures/electron-fixture';

interface MockOllamaServer {
  readonly port: number;
  readonly requestLog: readonly string[];
  stop: () => Promise<void>;
}

async function startMockOllama(port: number): Promise<MockOllamaServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(`${req.method} ${path}`);

    // Match the two endpoints the discovery+catalog probes hit in order.
    if (path.startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'qwen3:latest',
              model: 'qwen3:latest',
              modified_at: '2026-04-17T00:00:00Z',
              size: 1,
              digest: 'sha256:abc',
              details: { families: ['qwen3'] },
            },
          ],
        })
      );
      return;
    }
    if (path.startsWith('/api/version')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.13.3' }));
      return;
    }
    if (path.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3:latest' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind explicitly to 127.0.0.1 (IPv4) to match what the probe targets;
    // OS-level dual-stack binding could otherwise land on ::1 and be missed.
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    port,
    requestLog: requests,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.describe('Local Runtimes desktop probe integration', { tag: '@smoke' }, () => {
  let ollama: MockOllamaServer | undefined;

  test.beforeAll(async () => {
    ollama = await startMockOllama(11_434);
  });

  test.afterAll(async () => {
    await ollama?.stop();
  });

  test('detects a running Ollama on 127.0.0.1:11434 via the main-process bridge', async ({
    window,
    homePage,
  }) => {
    await homePage.openSettings();

    // Navigate to the new Local Runtimes category. Scoped to the settings
    // nav to avoid clashing with any global-nav entries of the same name.
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /Local Runtimes/i })
      .click();
    await expect(window.getByTestId('settings-category-local-runtimes')).toBeVisible({
      timeout: 10_000,
    });

    // The Ollama card renders its status in a badge next to the heading.
    // The main-process probe fires on mount and should flip the badge to
    // "Available" within a few seconds.
    const ollamaCard = window
      .getByRole('heading', { name: 'Ollama', exact: true })
      .locator('..')
      .locator('..');
    await expect(ollamaCard).toContainText(/Available/i, { timeout: 15_000 });

    // Prove the probe actually hit our mock — if nothing shows up here
    // the renderer is talking to a different origin (or the bridge is
    // broken). The discovery probe hits /v1/models; the catalog probe
    // hits /api/tags.
    expect(ollama?.requestLog.some((entry) => entry.includes('/api/tags'))).toBe(true);
  });
});
