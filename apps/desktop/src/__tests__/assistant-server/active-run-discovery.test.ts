import type http from 'node:http';
import { assistantDataStreamSessions } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import {
  handleActiveRunDiscoveryRequest,
  registerInitializingAssistantRun,
} from '../../assistant-server/active-run-discovery';

function request(url: string): http.IncomingMessage {
  return { method: 'GET', url } as http.IncomingMessage;
}

function response() {
  const result: { body?: unknown; status?: number } = {};
  const res = {
    end: (body: string) => {
      result.body = JSON.parse(body) as unknown;
    },
    setHeader: () => undefined,
    set statusCode(status: number) {
      result.status = status;
    },
  } as unknown as http.ServerResponse;
  return { res, result };
}

describe('active run discovery', () => {
  it('requires an exact resource and thread scope', () => {
    const { res, result } = response();
    handleActiveRunDiscoveryRequest(request('/assistant/active-run?threadId=thread'), res);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_active_run_scope' });
  });

  it('reports initialization until the exact replay session exists', async () => {
    const release = registerInitializingAssistantRun('owner-discovery', 'thread-discovery');
    const pending = response();
    handleActiveRunDiscoveryRequest(
      request('/assistant/active-run?resourceId=owner-discovery&threadId=thread-discovery'),
      pending.res
    );
    expect(pending.result).toEqual({ body: { activeRun: null, initializing: true }, status: 200 });

    const gate = Promise.withResolvers<void>();
    const session = assistantDataStreamSessions.create(
      (async function* () {
        await gate.promise;
        yield* [];
      })(),
      {
        discovery: {
          inputMessage: {
            id: 'user-discovery',
            parts: [{ text: 'Input', type: 'text' }],
            role: 'user',
          },
          inputParentMessageId: null,
          parentMessageId: 'user-discovery',
          resourceId: 'owner-discovery',
          runId: 'run-discovery',
          threadId: 'thread-discovery',
        },
        messageId: 'assistant-discovery',
      }
    );
    const active = response();
    handleActiveRunDiscoveryRequest(
      request('/assistant/active-run?resourceId=owner-discovery&threadId=thread-discovery'),
      active.res
    );
    expect(active.result.body).toMatchObject({
      activeRun: { eventId: `${session.id}:-1`, runId: 'run-discovery', state: 'active' },
    });

    release();
    gate.resolve();
    await session.whenClosed();
    const retained = response();
    handleActiveRunDiscoveryRequest(
      request('/assistant/active-run?resourceId=owner-discovery&threadId=thread-discovery'),
      retained.res
    );
    expect(retained.result.body).toMatchObject({ activeRun: { state: 'closed' } });
  });
});
