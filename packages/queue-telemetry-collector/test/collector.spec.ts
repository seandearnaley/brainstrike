import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueTelemetryCollector } from '../src';
import { createQueueTelemetryCollector } from '../src';

async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return response;
}

describe('createQueueTelemetryCollector', () => {
  let collector: QueueTelemetryCollector | null = null;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    if (collector?.isRunning()) {
      await collector.stop();
    }
    collector = null;
  });

  it('accepts valid telemetry batches and exposes them via helpers', async () => {
    const onBatch = vi.fn();
    collector = createQueueTelemetryCollector({ onBatch });
    await collector.start();

    const endpoint = collector.getEndpoint();
    expect(endpoint).not.toBeNull();

    const payload = {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'task-1',
        },
      ],
      metadata: { sessionId: 'abc' },
    };

    const response = await postJson(endpoint as string, payload);
    expect(response.status).toBe(204);

    const batch = await collector?.nextBatch({ timeoutMs: 200 });
    expect(batch.runtime).toBe('browser');
    expect(batch.metadata).toEqual({ sessionId: 'abc' });
    expect(onBatch).toHaveBeenCalledTimes(1);

    const stored = collector?.listBatches();
    expect(stored).toHaveLength(1);
    collector?.clearBatches();
    expect(collector?.listBatches()).toHaveLength(0);
  });

  it('normalises metadata and rejects invalid payloads', async () => {
    collector = createQueueTelemetryCollector({ path: '/telemetry' });
    await collector.start();
    const endpoint = collector.getEndpoint();
    expect(endpoint).not.toBeNull();

    const invalidPayload = {
      runtime: 'node',
      sentAt: new Date().toISOString(),
      events: [],
      metadata: 'not-an-object',
    };
    const invalidResponse = await postJson(endpoint as string, invalidPayload);
    expect(invalidResponse.status).toBe(400);
    const invalidBody = await invalidResponse.json();
    expect(invalidBody.error).toContain('Invalid runtime');

    const validResponse = await postJson(endpoint as string, {
      runtime: 'electron-renderer',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'complete',
          taskId: 'task-1',
        },
      ],
      metadata: 'ignored',
    });
    expect(validResponse.status).toBe(204);
    const batch = await collector?.nextBatch({ timeoutMs: 200 });
    expect(batch.metadata).toBeNull();
  });

  it('enforces API keys and supported methods', async () => {
    collector = createQueueTelemetryCollector({ apiKey: 'secret-key' });
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const payload = {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'error',
          taskId: 'task-2',
        },
      ],
    };

    const unauthorized = await postJson(endpoint, payload);
    expect(unauthorized.status).toBe(401);

    const wrongKey = await postJson(endpoint, payload, { 'x-api-key': 'wrong-key' });
    expect(wrongKey.status).toBe(401);

    const authorized = await postJson(endpoint, payload, { 'x-api-key': 'secret-key' });
    expect(authorized.status).toBe(204);

    const getResponse = await fetch(endpoint, { method: 'GET' });
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get('allow')).toBe('POST');
  });

  it('validates request paths and content', async () => {
    collector = createQueueTelemetryCollector({ path: '/collector' });
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const wrongPath = await postJson(`${endpoint}-extra`, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [],
    });
    expect(wrongPath.status).toBe(404);

    const badJson = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(badJson.status).toBe(400);
    const body = await badJson.json();
    expect(body.error).toBe('Invalid JSON payload');

    const badEvents = await postJson(endpoint, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [{ timestamp: 'not-a-number' }],
    });
    expect(badEvents.status).toBe(400);
    const badEventBody = await badEvents.json();
    expect(badEventBody.error).toBe('Invalid telemetry events');
  });

  it('returns payload too large when telemetry bodies exceed the configured cap', async () => {
    collector = createQueueTelemetryCollector({ maxBodyBytes: 24 });
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const response = await postJson(endpoint, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [],
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('connection')).toBe('close');
    await expect(response.json()).resolves.toEqual({ error: 'Payload too large' });
    expect(collector.listBatches()).toHaveLength(0);
  });

  it('rejects when no batch arrives before timeout', async () => {
    collector = createQueueTelemetryCollector();
    await collector.start();
    await expect(collector.nextBatch({ timeoutMs: 10 })).rejects.toThrow(
      'Timed out waiting for telemetry batch'
    );
  });

  it('resolves pending listeners when a batch arrives later', async () => {
    collector = createQueueTelemetryCollector();
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const pending = collector.nextBatch({ timeoutMs: 300 });

    const response = await postJson(endpoint, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'task-late',
        },
      ],
    });
    expect(response.status).toBe(204);

    const batch = await pending;
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.taskId).toBe('task-late');
  });

  it('trims stored batches to the configured maximum', async () => {
    collector = createQueueTelemetryCollector({
      path: '/telemetry/',
      maxStoredBatches: 1,
    });
    await collector.start();
    const endpoint = collector.getEndpoint();
    expect(endpoint).toMatch(/\/telemetry$/);

    const first = await postJson(endpoint as string, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'first',
        },
      ],
    });
    expect(first.status).toBe(204);

    const second = await postJson(endpoint as string, {
      runtime: 'browser',
      sentAt: new Date().toISOString(),
      events: [
        {
          timestamp: Date.now(),
          adapter: 'workerpool',
          event: 'complete',
          taskId: 'second',
        },
      ],
    });
    expect(second.status).toBe(204);

    const stored = collector.listBatches();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.events[0]?.taskId).toBe('second');
  });

  it('stops the collector and clears endpoint metadata', async () => {
    collector = createQueueTelemetryCollector();
    await collector.start();
    expect(collector.isRunning()).toBe(true);
    expect(collector.getEndpoint()).not.toBeNull();

    await collector.stop();
    expect(collector.isRunning()).toBe(false);
    expect(collector.getEndpoint()).toBeNull();

    await collector.stop(); // second stop is a no-op
  });
});
