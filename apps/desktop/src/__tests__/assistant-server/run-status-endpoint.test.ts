/**
 * GET /assistant/run-status — durable-run-row projection behind the
 * renderer's reattachment-record reclaim (2026-08-18 field failure). The
 * projection must be truthful: known statuses pass through, a missing row is
 * `unknown`, and unrecognized stored statuses or read failures 500 rather
 * than coercing to something the client could reclaim against.
 */
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleRunStatusRequest } from '../../assistant-server/run-status-endpoint';

interface CapturedResponse {
  body: unknown;
  status: number | undefined;
}

function makeResponse(captured: CapturedResponse): http.ServerResponse {
  const response = {
    end: (chunk?: unknown) => {
      if (typeof chunk === 'string') {
        captured.body = JSON.parse(chunk);
      }
    },
    setHeader: () => undefined,
    statusCode: 200,
    writeHead: (status: number) => {
      captured.status = status;
      return response;
    },
  };
  return new Proxy(response, {
    set(target, property, value) {
      if (property === 'statusCode' && typeof value === 'number') {
        captured.status = value;
      }
      return Reflect.set(target, property, value);
    },
  }) as unknown as http.ServerResponse;
}

function makeRequest(url: string): http.IncomingMessage {
  return { headers: {}, method: 'GET', url } as unknown as http.IncomingMessage;
}

function makeDatabase(rows: unknown[] | Error) {
  return () =>
    Promise.resolve({
      query: () => {
        if (rows instanceof Error) {
          return Promise.reject(rows);
        }
        return Promise.resolve({ rows });
      },
    });
}

describe('handleRunStatusRequest', () => {
  it('projects cancelling without treating it as terminal or unknown', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status?runId=run-cancel'),
      makeResponse(captured),
      makeDatabase([{ status: 'cancelling' }])
    );
    expect(captured).toEqual({ body: { runId: 'run-cancel', status: 'cancelling' }, status: 200 });
  });

  it('projects a known durable status', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status?runId=run-1'),
      makeResponse(captured),
      makeDatabase([{ status: 'completed' }])
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ runId: 'run-1', status: 'completed' });
  });

  it('reports a missing durable row as unknown', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status?runId=run-gone'),
      makeResponse(captured),
      makeDatabase([])
    );
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ runId: 'run-gone', status: 'unknown' });
  });

  it('rejects a missing runId parameter', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status'),
      makeResponse(captured),
      makeDatabase([])
    );
    expect(captured.status).toBe(400);
  });

  it('500s on read failure instead of fabricating a status', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status?runId=run-1'),
      makeResponse(captured),
      makeDatabase(new Error('db host unavailable'))
    );
    expect(captured.status).toBe(500);
  });

  it('500s on an unrecognized stored status instead of coercing', async () => {
    const captured: CapturedResponse = { body: undefined, status: undefined };
    await handleRunStatusRequest(
      makeRequest('/assistant/run-status?runId=run-1'),
      makeResponse(captured),
      makeDatabase([{ status: 'archived' }])
    );
    expect(captured.status).toBe(500);
  });
});
