import type http from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleRefreshAgentColorsRequest } from '../../assistant-server/refresh-agent-colors-endpoint';

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(async () => ({})),
  refresh: vi.fn(async () => 2),
}));
vi.mock('../../db-main', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../assistant-server/refresh-delegated-family-colors', () => ({
  refreshDelegatedFamilyColors: mocks.refresh,
}));

async function request(body: string): Promise<{
  body: Record<string, unknown>;
  headers: Map<string, string>;
  status: number;
}> {
  const headers = new Map<string, string>();
  const response = {
    end: vi.fn((value: string) => {
      responseBody = JSON.parse(value) as Record<string, unknown>;
    }),
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    statusCode: 200,
  };
  let responseBody: Record<string, unknown> = {};
  const stream = Readable.from([body]);
  await handleRefreshAgentColorsRequest(
    stream as unknown as http.IncomingMessage,
    response as unknown as http.ServerResponse
  );
  return { body: responseBody, headers, status: response.statusCode };
}

describe('refresh agent colors request boundary', () => {
  it('returns 413 and closes the connection for an oversized body', async () => {
    const result = await request('x'.repeat(4097));
    expect(result.status).toBe(413);
    expect(result.headers.get('connection')).toBe('close');
    expect(result.body['error']).toBe('request_body_too_large');
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('keeps malformed JSON at 400', async () => {
    const result = await request('{');
    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('invalid_agent_color_refresh');
    expect(result.headers.has('connection')).toBe(false);
  });

  it('still runs a valid refresh', async () => {
    const result = await request(
      JSON.stringify({ ownerResourceId: 'owner', rootThreadId: 'root' })
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ changed: 2 });
    expect(mocks.refresh).toHaveBeenCalledWith(
      {},
      { ownerResourceId: 'owner', rootThreadId: 'root' }
    );
  });
});
