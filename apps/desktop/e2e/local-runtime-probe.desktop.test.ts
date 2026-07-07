/**
 * End-to-end integration test for the main-process probe bridge.
 *
 * This test addresses a user bug report: "ran the desktop app with Ollama
 * running locally and the probe didn't find it." The root cause was CORS —
 * Chromium in the renderer enforces Ollama's OLLAMA_ORIGINS allow-list,
 * which does not include Electron's file:// / app:// origin. The fix runs
 * probes in the main process over IPC (apps/desktop/src/ipc-runtime.ts).
 *
 * Strategy:
 *  1. Stand up a mock Ollama on an EPHEMERAL port (port 0 → OS-assigned).
 *     Fixed ports collide with whatever the CI runner already has bound;
 *     ephemeral is the only reliable option on shared runners.
 *  2. Boot the desktop app, open Settings → Local Runtimes, type the mock
 *     URL into the Ollama baseUrl field, and save. That triggers a probe
 *     with the configured baseUrl flowing through the main-process bridge.
 *  3. Assert the Ollama card flips to Available AND the mock received the
 *     probe request — if the probe drifts back into the renderer CORS will
 *     re-block it and the mock log stays empty.
 *
 * This shape doubles as a regression for the `localRuntimeBaseUrl` override
 * path that users rely on for remote / custom hosts.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures/electron-fixture';

interface MockOllamaServer {
  readonly port: number;
  readonly requestLog: readonly string[];
  stop: () => Promise<void>;
}

async function startMockOllama(): Promise<MockOllamaServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(`${req.method} ${path}`);

    // CORS preflight handling in case Chromium sends one — the whole point of
    // this test is that the probe goes through the main process and avoids
    // CORS entirely, but respond correctly just in case a renderer fallback
    // kicks in during a regression (the assertion at the end of the test
    // proves which path ran).
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path.startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              details: { families: ['qwen3'] },
              digest: 'sha256:abc',
              model: 'qwen3:latest',
              modified_at: '2026-04-17T00:00:00Z',
              name: 'qwen3:latest',
              size: 1,
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

  // Bind explicitly to 127.0.0.1 (IPv4) to match what the probe targets;
  // OS-level dual-stack binding could otherwise land on ::1 and be missed.
  // Port 0 lets the OS pick a free port so we never collide with whatever
  // the CI runner already has on 11434.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    requestLog: requests,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.describe('Local Runtimes desktop probe integration', { tag: '@smoke' }, () => {
  let ollama: MockOllamaServer | undefined;

  test.beforeAll(async () => {
    ollama = await startMockOllama();
  });

  test.afterAll(async () => {
    await ollama?.stop();
  });

  test('detects a running Ollama via the main-process bridge when baseUrl is configured', async ({
    window,
    homePage,
  }) => {
    const mockUrl = `http://127.0.0.1:${ollama?.port}`;

    await homePage.openSettings();
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: /Local Runtimes/i })
      .click();
    await expect(window.getByTestId('settings-category-local-runtimes')).toBeVisible({
      timeout: 10_000,
    });

    // Point the Ollama card at the mock server via the baseUrl input. Using
    // the real UI path (type + click Save) exercises the same store-update /
    // re-probe flow a user triggers — a programmatic store.setState would
    // skip the save-and-probe-now handler.
    const urlInput = window.getByTestId('local-runtime-url-input-ollama');
    await urlInput.fill(mockUrl);
    await window.getByTestId('local-runtime-url-save-ollama').click();

    // The card renders its status in a badge; the re-probe should flip it to
    // Available once the bridge completes. Scope to Ollama's card so an
    // Unavailable LM Studio card (no mock) doesn't satisfy the expectation.
    const ollamaCard = window
      .getByRole('heading', { exact: true, name: 'Ollama' })
      .locator('..')
      .locator('..');
    await expect(ollamaCard).toContainText(/Available/i, { timeout: 15_000 });

    // If the probe silently drifted back into the renderer, Chromium's CORS
    // policy would block it even with Access-Control-Allow-Origin:* because
    // `file://` origins can't be matched by a wildcard. Mock receiving the
    // request at all proves the main-process bridge is live. Check any
    // Ollama-shaped endpoint — the discovery probe fires `/v1/models` first
    // (short-circuits on success), so matching on a specific path like
    // `/api/tags` would only succeed if the catalog also ran, which the
    // Settings card's Probe Now / Save flow does NOT currently trigger.
    expect(
      ollama?.requestLog.some(
        (entry) =>
          entry.includes('/v1/models') ||
          entry.includes('/api/tags') ||
          entry.includes('/api/version')
      )
    ).toBe(true);
  });
});
