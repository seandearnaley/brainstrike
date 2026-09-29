import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Route } from '@playwright/test';
import {
  resetEmbeddingHost,
  setVectorDevicePreference,
  stopEmbeddingHost,
  waitForEmbeddingHostState,
} from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';

const OLLAMA_EMBEDDING_URL = 'http://127.0.0.1:11434/v1/embeddings';

test('Stop acknowledges an active hosted embedding request after aborting its transport', async ({
  window,
}) => {
  test.setTimeout(90_000);
  let requestStarted = false;
  let requestClosed = false;
  let serverListening = false;
  let routeInstalled = false;
  const context = window.context();
  let mockUrl = '';
  const redirectHostedEmbedding = (route: Route): Promise<void> => route.continue({ url: mockUrl });
  const server = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*');
    response.setHeader('access-control-allow-headers', '*');
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    response.setHeader('access-control-allow-private-network', 'true');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
      response.writeHead(404);
      response.end();
      return;
    }
    requestStarted = true;
    response.on('close', () => {
      requestClosed = true;
    });
    // Keep inference in flight. Only the controller's AbortSignal can release
    // the browser fetch; a fake successful response would not test Stop.
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    serverListening = true;
    mockUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`;
    await context.route(OLLAMA_EMBEDDING_URL, redirectHostedEmbedding);
    routeInstalled = true;

    await setVectorDevicePreference(window, 'wasm');
    await resetEmbeddingHost(window);
    await waitForEmbeddingHostState(window, (status) => status.state === 'running');

    const jobId = await window.evaluate(async () => {
      const db = (
        globalThis as typeof globalThis & {
          electronAPI?: {
            db?: { query?: (sql: string, params?: unknown[]) => Promise<unknown> };
          };
        }
      ).electronAPI?.db;
      if (!db?.query) {
        throw new Error('Desktop database bridge is unavailable.');
      }
      const suffix = crypto.randomUUID();
      const now = new Date().toISOString();
      const modelKey = 'ollama::stop-test-model';
      const setId = `stop-set-${suffix}`;
      const fileId = `stop-file-${suffix}`;
      const chunkId = `stop-chunk-${suffix}`;
      const jobId = `stop-job-${suffix}`;
      const contentHash = `stop-hash-${suffix}`;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${contentHash}:${modelKey}`)
      );
      const embeddingInputHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      await db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
         VALUES ($1, $2, 'stop-test-model', 768, 'cosine', $3)`,
        [setId, modelKey, now]
      );
      await db.query(
        `INSERT INTO file_records (id, name, path, size, content, content_hash, token_count, created_at, updated_at)
         VALUES ($1, 'stop.txt', '/stop.txt', 100, 'hold request', $2, 10, $3, $3)`,
        [fileId, contentHash, now]
      );
      await db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, 0, 'hold request', $3, 10, 'text', 10, $4, $4)`,
        [chunkId, fileId, contentHash, now]
      );
      await db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
         VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash,
            embeddingSetId: setId,
            expectedDimension: 768,
            modelKey,
            sourceContentHash: contentHash,
          }),
          now,
        ]
      );
      return jobId;
    });

    await expect.poll(() => requestStarted, { timeout: 30_000 }).toBe(true);
    expect(requestClosed).toBe(false);
    const stopStartedAt = performance.now();
    const status = await stopEmbeddingHost(window);
    const stopDurationMs = performance.now() - stopStartedAt;

    expect(status.state).toBe('stopped');
    expect(status.commandId).toMatch(/^embedding-host-command:/);
    expect(stopDurationMs).toBeLessThan(3000);
    await expect.poll(() => requestClosed, { timeout: 3000 }).toBe(true);

    const job = await window.evaluate(async (id) => {
      const query = (
        globalThis as typeof globalThis & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Array<{ attempts: number; state: string }> }>;
            };
          };
        }
      ).electronAPI?.db?.query;
      if (!query) {
        throw new Error('Desktop database bridge is unavailable.');
      }
      return (await query('SELECT state, attempts FROM job_queue WHERE id = $1', [id])).rows[0];
    }, jobId);
    expect(job).toMatchObject({ attempts: 1, state: 'running' });
  } finally {
    try {
      if (routeInstalled) {
        await context.unroute(OLLAMA_EMBEDDING_URL, redirectHostedEmbedding);
      }
    } finally {
      if (serverListening) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
});
