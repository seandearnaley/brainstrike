import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueTelemetryCollector } from '../src';
import { createQueueTelemetryCollector } from '../src';

async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
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
      events: [
        {
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'task-1',
          timestamp: Date.now(),
        },
      ],
      metadata: { sessionId: 'abc' },
      runtime: 'browser',
      sentAt: new Date().toISOString(),
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

  it('normalises configured paths and ignores repeated starts', async () => {
    collector = createQueueTelemetryCollector({ path: 'telemetry' });
    await collector.start();

    const endpoint = collector.getEndpoint();
    expect(endpoint).toMatch(/\/telemetry$/);

    await collector.start();
    expect(collector.getEndpoint()).toBe(endpoint);
  });

  it('normalises metadata and rejects invalid payloads', async () => {
    collector = createQueueTelemetryCollector({ path: '/telemetry' });
    await collector.start();
    const endpoint = collector.getEndpoint();
    expect(endpoint).not.toBeNull();

    const invalidPayload = {
      events: [],
      metadata: 'not-an-object',
      runtime: 'node',
      sentAt: new Date().toISOString(),
    };
    const invalidResponse = await postJson(endpoint as string, invalidPayload);
    expect(invalidResponse.status).toBe(400);
    const invalidBody = await invalidResponse.json();
    expect(invalidBody.error).toContain('Invalid runtime');

    const validResponse = await postJson(endpoint as string, {
      events: [
        {
          adapter: 'workerpool',
          event: 'complete',
          taskId: 'task-1',
          timestamp: Date.now(),
        },
      ],
      metadata: 'ignored',
      runtime: 'electron-renderer',
      sentAt: new Date().toISOString(),
    });
    expect(validResponse.status).toBe(204);
    const batch = await collector?.nextBatch({ timeoutMs: 200 });
    expect(batch.metadata).toBeNull();
  });

  it('keeps accepting batches when the observer callback rejects', async () => {
    const onBatch = vi.fn(async () => {
      throw new Error('observer failed');
    });
    collector = createQueueTelemetryCollector({ onBatch });
    await collector.start();

    const response = await postJson(collector.getEndpoint() as string, {
      events: [
        {
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'task-observed',
          timestamp: Date.now(),
        },
      ],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });

    expect(response.status).toBe(204);
    expect(onBatch).toHaveBeenCalledTimes(1);
    await expect(collector.nextBatch({ timeoutMs: 200 })).resolves.toMatchObject({
      runtime: 'browser',
    });
  });

  it('enforces API keys and supported methods', async () => {
    collector = createQueueTelemetryCollector({ apiKey: 'secret-key' });
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const payload = {
      events: [
        {
          adapter: 'workerpool',
          event: 'error',
          taskId: 'task-2',
          timestamp: Date.now(),
        },
      ],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
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
      events: [],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });
    expect(wrongPath.status).toBe(404);

    const badJson = await fetch(endpoint, {
      body: '{bad json',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(badJson.status).toBe(400);
    const body = await badJson.json();
    expect(body.error).toBe('Invalid JSON payload');

    const badEvents = await postJson(endpoint, {
      events: [{ timestamp: 'not-a-number' }],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });
    expect(badEvents.status).toBe(400);
    const badEventBody = await badEvents.json();
    expect(badEventBody.error).toBe('Invalid telemetry events');
  });

  it('rejects non-object payloads and malformed timestamps', async () => {
    collector = createQueueTelemetryCollector();
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const arrayPayload = await fetch(endpoint, {
      body: '[]',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(arrayPayload.status).toBe(400);
    await expect(arrayPayload.json()).resolves.toEqual({ error: 'Payload must be an object' });

    const nonStringSentAt = await postJson(endpoint, {
      events: [],
      runtime: 'browser',
      sentAt: 123,
    });
    expect(nonStringSentAt.status).toBe(400);
    await expect(nonStringSentAt.json()).resolves.toEqual({
      error: 'Invalid sentAt timestamp',
    });

    const invalidDateSentAt = await postJson(endpoint, {
      events: [],
      runtime: 'browser',
      sentAt: 'not-a-date',
    });
    expect(invalidDateSentAt.status).toBe(400);
    await expect(invalidDateSentAt.json()).resolves.toEqual({
      error: 'Invalid sentAt timestamp',
    });

    const nonObjectEvent = await postJson(endpoint, {
      events: [null],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });
    expect(nonObjectEvent.status).toBe(400);
    await expect(nonObjectEvent.json()).resolves.toEqual({
      error: 'Invalid telemetry events',
    });
  });

  it('returns payload too large when telemetry bodies exceed the configured cap', async () => {
    collector = createQueueTelemetryCollector({ maxBodyBytes: 24 });
    await collector.start();
    const endpoint = collector.getEndpoint() as string;

    const response = await postJson(endpoint, {
      events: [],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
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
      events: [
        {
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'task-late',
          timestamp: Date.now(),
        },
      ],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });
    expect(response.status).toBe(204);

    const batch = await pending;
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.taskId).toBe('task-late');
  });

  it('trims stored batches to the configured maximum', async () => {
    collector = createQueueTelemetryCollector({
      maxStoredBatches: 1,
      path: '/telemetry/',
    });
    await collector.start();
    const endpoint = collector.getEndpoint();
    expect(endpoint).toMatch(/\/telemetry$/);

    const first = await postJson(endpoint as string, {
      events: [
        {
          adapter: 'workerpool',
          event: 'enqueue',
          taskId: 'first',
          timestamp: Date.now(),
        },
      ],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
    });
    expect(first.status).toBe(204);

    const second = await postJson(endpoint as string, {
      events: [
        {
          adapter: 'workerpool',
          event: 'complete',
          taskId: 'second',
          timestamp: Date.now(),
        },
      ],
      runtime: 'browser',
      sentAt: new Date().toISOString(),
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
