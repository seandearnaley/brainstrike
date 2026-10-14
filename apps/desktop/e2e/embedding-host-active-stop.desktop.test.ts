import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { stopEmbeddingHost } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';

test('Stop acknowledges an active hosted embedding request after aborting its transport', async ({
  window,
}) => {
  test.setTimeout(90_000);
  const requests: unknown[] = [];
  let requestClosed = false;
  let serverListening = false;
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push(JSON.parse(body));
    });
    response.on('close', () => {
      requestClosed = true;
    });
    // Main owns this hosted fetch. Keep its real HTTP response pending until
    // Stop aborts and joins it; no renderer interception or successful response.
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    serverListening = true;
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await window.evaluate(async (localRuntimeBaseUrl) => {
      const storage = globalThis.window.electronAPI?.storage;
      if (!storage) {
        throw new Error('Desktop storage is unavailable.');
      }
      await storage.setItem(
        'assistant-preferences.v1',
        JSON.stringify({
          state: { providerSettings: { ollama: { localRuntimeBaseUrl } } },
          version: 1,
        })
      );
    }, baseUrl);

    const requestId = crypto.randomUUID();
    const pending = window
      .evaluate(async (id) => {
        const host = (
          globalThis.window as Window & { readonly embeddingHost?: VisibleEmbeddingHostBridge }
        ).embeddingHost;
        if (!(host && 'queryEmbedding' in host)) {
          throw new Error('Hosted query is unavailable.');
        }
        return await host.queryEmbedding(
          {
            dimensions: 768,
            modelId: 'stop-test-model',
            modelKey: 'ollama::stop-test-model',
            query: 'hold request',
          },
          { requestId: id }
        );
      }, requestId)
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ error, kind: 'transport-error' as const })
      );

    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);
    expect(requests).toEqual([
      { encoding_format: 'float', input: ['hold request'], model: 'stop-test-model' },
    ]);
    expect(requestClosed).toBe(false);
    const stopStartedAt = performance.now();
    const status = await stopEmbeddingHost(window);
    const stopDurationMs = performance.now() - stopStartedAt;

    expect(status).toEqual({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:stopped',
      runtimeKind: 'embedding-host',
      state: 'stopped',
    });
    expect(stopDurationMs).toBeLessThan(3000);
    await expect.poll(() => requestClosed, { timeout: 3000 }).toBe(true);
    const outcome = await pending;
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') {
      throw outcome.error;
    }
    expect(outcome.result.ok).toBe(false);

    const replay = await window.evaluate(async (id) => {
      const host = (
        globalThis.window as Window & { readonly embeddingHost?: VisibleEmbeddingHostBridge }
      ).embeddingHost;
      if (!(host && 'queryEmbedding' in host)) {
        throw new Error('Hosted query is unavailable.');
      }
      return await host.queryEmbedding(
        {
          dimensions: 768,
          modelId: 'stop-test-model',
          modelKey: 'ollama::stop-test-model',
          query: 'hold request',
        },
        { requestId: id }
      );
    }, requestId);
    expect(replay.ok).toBe(false);
    if (replay.ok) {
      throw new Error('Retired query token was replayed.');
    }
    expect(replay.error.code).toBe('embedding.request-reused');
    expect(requests).toHaveLength(1);
  } finally {
    if (serverListening) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
