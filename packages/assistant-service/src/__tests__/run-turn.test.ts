/**
 * Package-level contract tests for runAssistantTurn (BST-972 B3 review
 * finding: the centerpiece landed with only the desktop http-partial-mock
 * suites as proof — the transport-coupled tests this extraction exists to
 * stop being the only guard). Both ports plus the session registry are
 * injected, so every case here is pure: no HTTP, no PGlite, no module mocks.
 */
import type { StreamChunk } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistantTurn } from '../run-turn';
import type { AgentStreamResult } from '../types';

const recordThreadRunStatus =
  vi.fn<
    (
      runId: string,
      status: 'cancelled' | 'completed' | 'failed',
      error: string | null
    ) => Promise<void>
  >();

async function* emptyStream(): AsyncIterable<StreamChunk> {
  // No chunks — the fake session ignores the stream entirely.
}

interface FakeSessionOptions {
  terminal?: { status: 'cancelled' | 'completed' | 'failed'; error: string | null };
}

function makeSessions(options: FakeSessionOptions = {}) {
  const createResponse = vi.fn(
    (init: { headers: Record<string, string> }) =>
      new Response(null, { headers: init.headers, status: 200 })
  );
  const session = {
    createResponse,
    getTerminalOutcome: vi.fn(
      () => options.terminal ?? { error: null, status: 'completed' as const }
    ),
    id: 'session-1',
    messageId: 'assistant-msg-1',
    whenClosed: vi.fn(() => Promise.resolve()),
  };
  const create = vi.fn(() => session);
  return { create, session } as const;
}

function baseParams(overrides: Record<string, unknown> = {}) {
  const sessions = makeSessions();
  return {
    params: {
      apiKey: 'k',
      assistantMessageId: undefined,
      executionSignal: new AbortController().signal,
      initializeStream: vi.fn(
        async (): Promise<AgentStreamResult> => ({ ok: true, stream: emptyStream() })
      ),
      messages: [],
      persistence: { recordThreadRunStatus },
      runId: 'run-1',
      runtimeData: { provider: 'openai' },
      sessions: sessions as never,
      ...overrides,
    },
    sessions,
  };
}

beforeEach(() => {
  recordThreadRunStatus.mockReset().mockResolvedValue();
});

describe('runAssistantTurn', () => {
  it('threads the auth input to the stream initializer as a DIRECT parameter (BST-1352)', async () => {
    // Never via RuntimeData: RequestContext.toJSON drops functions, so a
    // custom_fetch closure riding runtimeData would vanish silently.
    const authInput = {
      apiKey: 'dummy',
      fetch: (() => Promise.reject(new Error('unused'))) as typeof globalThis.fetch,
      kind: 'custom_fetch' as const,
    };
    const initializeStream = vi.fn(
      async (_params: { runtimeData: Record<string, unknown> }): Promise<AgentStreamResult> => ({
        ok: true,
        stream: emptyStream(),
      })
    );
    const { params } = baseParams({ authInput, initializeStream });

    const result = await runAssistantTurn(params as never);

    expect(result.ok).toBe(true);
    expect(initializeStream).toHaveBeenCalledWith(expect.objectContaining({ authInput }));
    const initArgs = initializeStream.mock.calls[0]?.[0];
    expect(initArgs?.runtimeData['authInput']).toBeUndefined();
  });

  it('records a failed run row and passes the failure through verbatim when init fails with a runId', async () => {
    const failure: AgentStreamResult = {
      ok: false,
      payload: { error: 'x_failed', message: 'nope', stage: 'stream_construction' },
      status: 502,
    };
    const { params } = baseParams({ initializeStream: vi.fn(async () => failure) });

    const result = await runAssistantTurn(params as never);

    expect(recordThreadRunStatus).toHaveBeenCalledWith('run-1', 'failed', 'nope');
    expect(result).toEqual({ ok: false, payload: failure.payload, status: 502 });
  });

  it('records cancellation when an in-flight initializer returns a structured failure after abort', async () => {
    const controller = new AbortController();
    const initialization = Promise.withResolvers<AgentStreamResult>();
    const failure: AgentStreamResult = {
      ok: false,
      payload: { error: 'initialization_failed', message: 'Provider setup failed' },
      status: 502,
    };
    const { params, sessions } = baseParams({
      executionSignal: controller.signal,
      initializeStream: vi.fn(() => initialization.promise),
    });
    const pendingTurn = runAssistantTurn(params as never);
    expect(recordThreadRunStatus).not.toHaveBeenCalled();

    controller.abort(new Error('Assistant run canceled by user.'));
    initialization.resolve(failure);
    const result = await pendingTurn;

    expect(recordThreadRunStatus).toHaveBeenCalledExactlyOnceWith(
      'run-1',
      'cancelled',
      'Assistant run canceled by user.'
    );
    expect(sessions.create).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, payload: failure.payload, status: 502 });
  });

  it('writes NOTHING on an init failure without a runId (the provenance gate)', async () => {
    const { params } = baseParams({
      initializeStream: vi.fn(
        async (): Promise<AgentStreamResult> => ({
          ok: false,
          payload: { error: 'x_failed', message: 'nope' },
          status: 502,
        })
      ),
      runId: undefined,
    });

    const result = await runAssistantTurn(params as never);

    expect(result.ok).toBe(false);
    expect(recordThreadRunStatus).not.toHaveBeenCalled();
  });

  it('cancelled wins over everything in the completion precedence', async () => {
    const controller = new AbortController();
    controller.abort();
    const { params } = baseParams({ executionSignal: controller.signal });

    const result = await runAssistantTurn(params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }
    await result.completion();

    expect(recordThreadRunStatus).toHaveBeenCalledWith(
      'run-1',
      'cancelled',
      'Assistant run canceled by user.'
    );
  });

  it('terminalStatus/terminalError from the stream result beat the session outcome', async () => {
    // The UserPromptSubmit-block path assistant-runtime.md documents: a
    // visibly failed turn that never invoked the model.
    const { params } = baseParams({
      initializeStream: vi.fn(
        async (): Promise<AgentStreamResult> => ({
          ok: true,
          stream: emptyStream(),
          terminalError: 'blocked by a hook',
          terminalStatus: 'failed',
        })
      ),
    });

    const result = await runAssistantTurn(params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }
    await result.completion();

    expect(recordThreadRunStatus).toHaveBeenCalledWith('run-1', 'failed', 'blocked by a hook');
  });

  it('falls through to the session outcome when neither abort nor terminalStatus apply', async () => {
    const sessions = makeSessions({ terminal: { error: 'stream broke', status: 'failed' } });
    const { params } = baseParams({ sessions: sessions as never });

    const result = await runAssistantTurn(params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }
    await result.completion();

    expect(recordThreadRunStatus).toHaveBeenCalledWith('run-1', 'failed', 'stream broke');
  });

  it('threads explicit OpenRouter model effort into output-limit recovery context', async () => {
    const turn = baseParams({
      runtimeData: {
        model: 'moonshotai/kimi-k3',
        provider: 'openrouter',
        providerOptions: {
          openrouter: {
            provider: { require_parameters: true },
            reasoning: { effort: 'max' },
          },
        },
        requestedReasoningEffort: 'max',
      },
    });

    const result = await runAssistantTurn(turn.params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }

    expect(turn.sessions.create).toHaveBeenCalledWith(expect.anything(), {
      outputLimitContext: {
        model: 'moonshotai/kimi-k3',
        provider: 'openrouter',
        reasoningEffort: 'max',
      },
    });
  });

  it('does not mistake Auto for an explicit resolved max effort', async () => {
    const turn = baseParams({
      runtimeData: {
        model: 'moonshotai/kimi-k3',
        provider: 'openrouter',
        providerOptions: {
          openrouter: {
            provider: { require_parameters: true },
            reasoning: { effort: 'max' },
          },
        },
      },
    });

    const result = await runAssistantTurn(turn.params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }

    expect(turn.sessions.create).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('threads assistantMessageId into session creation only when present, and stamps both headers', async () => {
    const withId = baseParams({ assistantMessageId: 'msg-42' });
    const withoutId = baseParams();

    const turnWith = await runAssistantTurn(withId.params as never);
    const turnWithout = await runAssistantTurn(withoutId.params as never);
    if (!(turnWith.ok && turnWithout.ok)) {
      throw new Error('expected turns');
    }

    expect(withId.sessions.create).toHaveBeenCalledWith(expect.anything(), {
      messageId: 'msg-42',
    });
    expect(withoutId.sessions.create).toHaveBeenCalledWith(expect.anything(), {});
    expect(withId.sessions.session.createResponse).toHaveBeenCalledWith({
      headers: {
        'X-Brainstrike-Assistant-Event-Id': 'session-1:-1',
        'X-Brainstrike-Assistant-Message-Id': 'assistant-msg-1',
      },
    });
  });

  it('the completion write only happens for turns carrying a runId', async () => {
    const { params } = baseParams({ runId: undefined });

    const result = await runAssistantTurn(params as never);
    if (!result.ok) {
      throw new Error('expected turn');
    }
    await result.completion();

    expect(recordThreadRunStatus).not.toHaveBeenCalled();
  });
});

it('queues the same root until its actual session and terminal write finish, while other roots proceed', async () => {
  const firstClosed = Promise.withResolvers<void>();
  const firstWritten = Promise.withResolvers<void>();
  const writeEntered = Promise.withResolvers<void>();
  const first = baseParams({
    runtimeData: { memory: { resourceId: 'owner', threadId: 'queued-root' }, provider: 'openai' },
  });
  first.sessions.session.whenClosed.mockReturnValue(firstClosed.promise);
  recordThreadRunStatus.mockImplementation(async (runId) => {
    if (runId !== 'run-1') {
      return;
    }
    writeEntered.resolve();
    await firstWritten.promise;
  });
  const firstTurn = await runAssistantTurn(first.params as never);
  if (!firstTurn.ok) {
    throw new Error('First root failed');
  }
  const second = baseParams({ runId: 'second', runtimeData: first.params.runtimeData });
  const queued = runAssistantTurn(second.params as never);
  const other = baseParams({
    runId: 'other',
    runtimeData: {
      memory: { resourceId: 'owner', threadId: 'independent-root' },
      provider: 'openai',
    },
  });
  try {
    const independent = await runAssistantTurn(other.params as never);
    if (!independent.ok) {
      throw new Error('Independent root failed');
    }
    expect(second.params.initializeStream).not.toHaveBeenCalled();
    firstClosed.resolve();
    await writeEntered.promise;
    expect(second.params.initializeStream).not.toHaveBeenCalled();
    firstWritten.resolve();
    await firstTurn.completion();
    const secondTurn = await queued;
    expect(second.params.initializeStream).toHaveBeenCalledTimes(1);
    if (!secondTurn.ok) {
      throw new Error('Queued root failed');
    }
    await Promise.all([secondTurn.completion(), independent.completion()]);
  } finally {
    firstClosed.resolve();
    firstWritten.resolve();
    await firstTurn.completion();
    const remaining = await queued;
    if (remaining.ok) {
      await remaining.completion();
    }
  }
});

it('cancels a queued request without releasing its predecessor or blocking its successor', async () => {
  const closed = Promise.withResolvers<void>();
  const scope = { resourceId: 'owner', threadId: 'cancel-queued-root' };
  const first = baseParams({ runtimeData: { memory: scope, provider: 'openai' } });
  first.sessions.session.whenClosed.mockReturnValue(closed.promise);
  const firstTurn = await runAssistantTurn(first.params as never);
  if (!firstTurn.ok) {
    throw new Error('First root failed');
  }
  const controller = new AbortController();
  const second = baseParams({
    executionSignal: controller.signal,
    runtimeData: first.params.runtimeData,
  });
  const queued = runAssistantTurn(second.params as never);
  const third = baseParams({ runId: 'third', runtimeData: first.params.runtimeData });
  const following = runAssistantTurn(third.params as never);
  try {
    controller.abort(new Error('Cancel queued follow-up'));
    await expect(queued).rejects.toThrow('Cancel queued follow-up');
    expect(second.params.initializeStream).not.toHaveBeenCalled();
    expect(third.params.initializeStream).not.toHaveBeenCalled();
    closed.resolve();
    await firstTurn.completion();
    const lastTurn = await following;
    if (!lastTurn.ok) {
      throw new Error('Following root failed');
    }
    expect(third.params.initializeStream).toHaveBeenCalledTimes(1);
    await lastTurn.completion();
  } finally {
    closed.resolve();
    await firstTurn.completion();
    const remaining = await following;
    if (remaining.ok) {
      await remaining.completion();
    }
  }
});
