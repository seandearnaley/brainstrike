import { describe, expect, it } from 'vitest';
import { __parseChatBodyForTests, POST } from '../route';

describe('chat route schema', () => {
  it('rejects invalid bodies with 400', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ id: '', role: 'user', parts: [] }] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('invalid_body');
  });

  it('accepts valid bodies and streams', async () => {
    const body = {
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      data: { projectId: 'p1' },
    } as const;

    // ensure parser passes
    const parsed = __parseChatBodyForTests(body);
    expect(parsed.messages[0].role).toBe('user');

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    // should contain newline-delimited JSON with at least one chunk
    const firstLine = text.split('\n').filter(Boolean)[0];
    const chunk = JSON.parse(firstLine);
    expect(['tool-event', 'text-delta']).toContain(chunk.type);
  });

  it('streams web.searchDocs tool events for documentation queries', async () => {
    const body = {
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'text', text: 'Search docs for telemetry checklist' }],
        },
      ],
    } as const;

    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const start = lines.find(
      (chunk) => chunk['name'] === 'web.searchDocs' && chunk['status'] === 'start'
    );
    expect(start).toBeDefined();

    const success = lines.find(
      (chunk) => chunk['name'] === 'web.searchDocs' && chunk['status'] === 'success'
    );
    expect(success).toBeDefined();

    const payload = (success?.['payload'] ?? {}) as Record<string, unknown>;
    const results = Array.isArray(payload['results']) ? (payload['results'] as unknown[]) : [];
    expect(results.length).toBeGreaterThan(0);
  });
});
