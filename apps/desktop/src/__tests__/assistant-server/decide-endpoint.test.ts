/**
 * POST /assistant/decide — a decision delivered INTO the running leg. The
 * transport must be exact: malformed bodies are 400, a leg without a live
 * control (settled, or not a parked background child) is a visible 404 so
 * the renderer takes the new-leg path, a host refusal is a 409 the card can
 * name, and the resolved TRUSTED policy snapshot reaches the control (never
 * the raw renderer request).
 */
import type http from 'node:http';
import { Readable } from 'node:stream';
import { DelegatedConversationIdentityError } from '@brainstrike/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDecideRequest } from '../../assistant-server/decide-endpoint';
import { registerDesktopDelegatedDecision } from '../../assistant-server/delegated-execution-controls';

vi.mock('@brainstrike/agent', async (original) => ({
  ...(await original<typeof import('@brainstrike/agent')>()),
}));

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

function makeRequest(body: unknown): http.IncomingMessage {
  const stream = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]);
  return Object.assign(stream, {
    headers: {},
    method: 'POST',
    url: '/assistant/decide',
  }) as unknown as http.IncomingMessage;
}

async function decide(body: unknown): Promise<CapturedResponse> {
  const captured: CapturedResponse = { body: undefined, status: undefined };
  await handleDecideRequest(makeRequest(body), makeResponse(captured));
  return captured;
}

const approval = {
  action: 'approve',
  delegation: {
    path: [
      {
        childRuntimeRunId: 'child-run',
        parentRuntimeRunId: 'root-run',
        parentToolCallId: 'delegate-1',
        personaId: 'explore',
      },
    ],
    toolCallId: 'child-call',
  },
  runId: 'root-run',
  toolCallId: 'delegate-1',
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe('handleDecideRequest', () => {
  it('rejects a malformed body, an unknown field, a bad runId and a non-action', async () => {
    expect((await decide('not json')).status).toBe(400);
    expect((await decide({ action: approval, extra: 1, runId: 'run-1' })).status).toBe(400);
    expect((await decide({ action: approval, runId: '' })).status).toBe(400);
    expect((await decide({ action: { runId: 'x' }, runId: 'run-1' })).status).toBe(400);
    // The policy request must be an object; its VALUES are validated by the
    // runtime resolver, exactly as on a stream request.
    expect(
      (await decide({ action: approval, permissionPolicyRequest: 'yes', runId: 'run-1' })).status
    ).toBe(400);
  });

  it('answers 404 when no running leg owns the decision', async () => {
    const captured = await decide({ action: approval, runId: 'run-none' });
    expect(captured.status).toBe(404);
    expect(captured.body).toMatchObject({ error: 'no_live_run' });
  });

  it('delivers the action with the TRUSTED resolved policy snapshot and answers 200', async () => {
    const control = vi.fn(async () => undefined);
    cleanups.push(registerDesktopDelegatedDecision('run-1', control));
    const captured = await decide({
      action: approval,
      permissionPolicyRequest: {
        enforce: true,
        policies: { edit: 'ask', execute: 'ask', mcp: 'allow', read: 'ask' },
        sessionGrants: ['read'],
      },
      runId: 'run-1',
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ delivered: true, runId: 'run-1' });
    expect(control).toHaveBeenCalledOnce();
    const [request] = control.mock.calls[0] as unknown as [
      { action: unknown; permissionPolicy?: Record<string, unknown> },
    ];
    expect(request.action).toEqual(approval);
    // Server-owned risk classification, never the renderer's shape.
    expect(request.permissionPolicy).toMatchObject({
      policies: { read: 'ask' },
      sessionGrants: ['read'],
      yolo: false,
    });
    expect(request.permissionPolicy?.['riskByTool']).toBeTypeOf('object');
  });

  it('omits the policy when the renderer did not opt in, and answers 409 on a host refusal', async () => {
    const control = vi.fn(async () => {
      throw new DelegatedConversationIdentityError('tool-action-already-consumed-or-root-busy');
    });
    cleanups.push(registerDesktopDelegatedDecision('run-2', control));
    const captured = await decide({
      action: approval,
      permissionPolicyRequest: { enforce: false },
      runId: 'run-2',
    });
    expect(captured.status).toBe(409);
    expect(captured.body).toMatchObject({
      error: 'decision_refused',
      reason: 'tool-action-already-consumed-or-root-busy',
    });
    const [request] = control.mock.calls[0] as unknown as [{ permissionPolicy?: unknown }];
    expect(request).not.toHaveProperty('permissionPolicy');
  });

  it('answers 500 when the native resume fails', async () => {
    cleanups.push(
      registerDesktopDelegatedDecision('run-3', async () => {
        throw new Error('resume exploded');
      })
    );
    const captured = await decide({ action: approval, runId: 'run-3' });
    expect(captured.status).toBe(500);
    expect(captured.body).toMatchObject({ error: 'decision_failed' });
  });
});
