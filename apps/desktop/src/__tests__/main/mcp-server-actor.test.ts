import {
  type McpHostOperationResult,
  type McpNegotiatedStatus,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpBearerCredentialFailure } from '../../mcp/bearer-credential';
import { McpLifecycleFailure } from '../../mcp/lifecycle-errors';
import {
  McpServerActor,
  type McpServerActorClient,
  McpServerActorClientCleanupError,
  type McpServerActorClientFactory,
} from '../../mcp/server-actor';

const linearId = parseConfiguredMcpServerId('linear');
const githubId = parseConfiguredMcpServerId('github');
const negotiated: McpNegotiatedStatus = {
  advertisedCapabilityIds: ['tools'],
  era: 'modern',
  revision: '2026-07-28',
};
const report = {
  callbacksClosed: 1,
  childProcessesClosed: 2,
  clientsClosed: 1,
  failures: [],
  loopbackPortsClosed: 3,
  probesClosed: 4,
  requestsSettled: 5,
  subscriptionsClosed: 6,
} as const;
const listResult: McpHostOperationResult = {
  result: {
    _meta: { custom: { retained: true } },
    nextCursor: 'next',
    tools: [
      {
        _meta: { custom: 'metadata' },
        annotations: { idempotentHint: true, readOnlyHint: true, title: 'Issues' },
        description: 'List issues',
        execution: { taskSupport: 'optional' },
        icons: [{ mimeType: 'image/png', sizes: ['16x16'], src: 'data:image/png;base64,AA==' }],
        inputSchema: { required: ['team'], type: 'object' },
        name: 'list_issues',
        outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema' },
        title: 'List issues',
      },
    ],
  },
  type: 'tools/list',
};
const callResult: McpHostOperationResult = {
  result: {
    _meta: { custom: 'metadata' },
    content: [
      { annotations: { audience: ['user'], priority: 1 }, text: 'ok', type: 'text' },
      { data: 'AA==', mimeType: 'image/png', type: 'image' },
      { data: 'AA==', mimeType: 'audio/wav', type: 'audio' },
      { resource: { text: 'body', uri: 'file:///result.txt' }, type: 'resource' },
      { name: 'details', size: 4, title: 'Details', type: 'resource_link', uri: 'file:///details' },
    ],
    isError: true,
    structuredContent: { issueId: 'BST-1503' },
  },
  type: 'tools/call',
};
const LIST = { configuredServerId: linearId, type: 'tools/list' } as const;
const CALL = { configuredServerId: linearId, toolName: 'list_issues', type: 'tools/call' } as const;
const deferred = <T>() => Promise.withResolvers<T>();
const base = (id: typeof linearId) => ({
  configuredProtocol: '2026-07-28' as const,
  configuredServerId: id,
  generation: 1,
  transport: 'streamable-http' as const,
});
function actor(
  factory: McpServerActorClientFactory,
  id = linearId,
  onInternalError: (code: string, cause: unknown) => void = vi.fn(),
  startup: 'automatic' | 'authentication-required' = 'automatic',
  clearCredentials?: () => Promise<void>
): McpServerActor {
  return new McpServerActor({
    ...base(id),
    ...(clearCredentials ? { clearCredentials } : {}),
    factory,
    onInternalError,
    startup,
  });
}
function client(
  invoke: McpServerActorClient['invoke'] = async (request) =>
    request.type === 'tools/list' ? listResult.result : callResult.result,
  close: McpServerActorClient['close'] = async () => report,
  status = negotiated
): McpServerActorClient {
  return { close, invoke, negotiated: status };
}
async function failure(promise: Promise<unknown>, code: string): Promise<unknown> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    code,
    message:
      code === 'mcp-authentication-required'
        ? 'MCP authentication required. Connect or reauthorize this server in Settings > AI Tools.'
        : 'MCP server actor operation failed',
  });
  expect(error).toHaveProperty('category', expect.any(String));
  expect(error).not.toHaveProperty('cause');
  return error;
}
describe('McpServerActor', () => {
  it('maps SDK and protocol failures to safe stable host categories', async () => {
    const cases = [
      [
        new SdkError(SdkErrorCode.ListPaginationExceeded, 'private pagination detail', {
          listMaxPages: 1,
          method: 'tools/list',
        }),
        'mcp-list-pagination-exceeded',
        'operation',
      ],
      [
        new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', {
          method: 'tools/call',
        }),
        'mcp-request-timeout',
        'operation',
      ],
      [
        new ProtocolError(-32_020, 'private header mismatch detail'),
        'mcp-header-mismatch',
        'protocol',
      ],
    ] as const;
    for (const [cause, code, category] of cases) {
      const subject = actor(async () =>
        client(async () => {
          throw cause;
        })
      );
      const error = await subject.invoke(LIST).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ category, code, message: 'MCP server actor operation failed' });
      // An `operation` failure is the CALL's failure, never the connection's:
      // it must reach the caller without retiring the generation (BST-1594).
      expect(subject.snapshot()).toMatchObject(
        category === 'operation'
          ? { state: 'connected' }
          : { error: { category, code }, state: 'error' }
      );
    }
  });

  it('keeps serving the same generation after an operation-category request timeout', async () => {
    const onInternalError = vi.fn();
    let failNext = true;
    const factory = vi.fn(async () =>
      client(async (request) => {
        if (failNext) {
          failNext = false;
          throw new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', {
            method: 'tools/call',
          });
        }
        return request.type === 'tools/list' ? listResult.result : callResult.result;
      })
    );
    const subject = actor(factory, linearId, onInternalError);

    await failure(subject.invoke(CALL), 'mcp-request-timeout');
    expect(onInternalError).toHaveBeenCalledWith('mcp-request-timeout', expect.any(SdkError));
    expect(subject.snapshot()).toMatchObject({ state: 'connected' });
    expect(subject.invalidated()).toBe(false);

    await expect(subject.invoke(LIST)).resolves.toEqual(listResult);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('retires a transport that answers nothing after consecutive request timeouts', async () => {
    // A wedged stdio child or a black-holed endpoint never closes the
    // transport, so `onUnexpectedClose` never fires and nothing else probes
    // liveness. Consecutive unanswered timeouts must therefore end in the
    // invalidated state `McpHostService` self-heals, not in a server that is
    // permanently and silently `connected` (BST-1594 review).
    const timeout = () =>
      new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', { method: 'tools/call' });
    const subject = actor(async () =>
      client(async () => {
        throw timeout();
      })
    );

    await failure(subject.invoke(CALL), 'mcp-request-timeout');
    expect(subject.snapshot()).toMatchObject({ state: 'connected' });
    expect(subject.invalidated()).toBe(false);

    await failure(subject.invoke(CALL), 'mcp-request-timeout');
    expect(subject.snapshot()).toMatchObject({
      error: { category: 'operation', code: 'mcp-request-timeout' },
      state: 'error',
    });
    expect(subject.invalidated()).toBe(true);
  });

  it('resets the request-timeout streak on any answer from the server', async () => {
    // One slow call between two answers must retire nothing, however many
    // times the pattern repeats: only an UNBROKEN run of unanswered timeouts
    // means the transport stopped answering.
    let timeoutNext = true;
    const subject = actor(async () =>
      client(async (request) => {
        if (timeoutNext) {
          timeoutNext = false;
          throw new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', {
            method: 'tools/call',
          });
        }
        timeoutNext = true;
        return request.type === 'tools/list' ? listResult.result : callResult.result;
      })
    );

    for (let round = 0; round < 3; round += 1) {
      await failure(subject.invoke(CALL), 'mcp-request-timeout');
      await expect(subject.invoke(LIST)).resolves.toEqual(listResult);
    }
    expect(subject.snapshot()).toMatchObject({ state: 'connected' });
    expect(subject.invalidated()).toBe(false);
  });

  it('resets the request-timeout streak on an answered operation-category failure', async () => {
    // A pagination cap is an operation failure the server had to ANSWER to
    // produce, so it is liveness evidence, not another silent timeout.
    const responses: (() => never)[] = [
      () => {
        throw new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', {
          method: 'tools/list',
        });
      },
      () => {
        throw new SdkError(SdkErrorCode.ListPaginationExceeded, 'private pagination detail', {
          listMaxPages: 1,
          method: 'tools/list',
        });
      },
      () => {
        throw new SdkError(SdkErrorCode.RequestTimeout, 'private timeout detail', {
          method: 'tools/list',
        });
      },
    ];
    const subject = actor(async () =>
      client(async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error('unexpected extra invocation');
        }
        return next();
      })
    );

    await failure(subject.invoke(LIST), 'mcp-request-timeout');
    await failure(subject.invoke(LIST), 'mcp-list-pagination-exceeded');
    await failure(subject.invoke(LIST), 'mcp-request-timeout');
    expect(subject.snapshot()).toMatchObject({ state: 'connected' });
    expect(subject.invalidated()).toBe(false);
  });

  it('preserves a bearer failure nested by the SDK operation boundary', async () => {
    const cause = new SdkError(SdkErrorCode.SendFailed, 'private SDK wrapper detail', {
      cause: new McpBearerCredentialFailure('mcp-bearer-credential-malformed'),
      method: 'tools/list',
    });
    const subject = actor(async () =>
      client(async () => {
        throw cause;
      })
    );

    const error = await subject.invoke(LIST).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      category: 'authentication',
      code: 'mcp-bearer-credential-malformed',
      message: 'MCP server actor operation failed',
    });
    expect(subject.snapshot()).toMatchObject({
      error: { category: 'authentication', code: 'mcp-bearer-credential-malformed' },
    });
  });

  it('keeps user-paced authentication actionable until an explicit connect', async () => {
    const factory = vi.fn(async () => client());
    const subject = actor(factory, linearId, vi.fn(), 'authentication-required');

    expect(subject.snapshot().state).toBe('authentication-required');
    await failure(subject.invoke(LIST), 'mcp-authentication-required');
    expect(factory).not.toHaveBeenCalled();

    await expect(subject.connect()).resolves.toMatchObject({ state: 'connected' });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('clears credentials only after an explicit disconnect closes the selected client', async () => {
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push('close');
      return report;
    });
    const clearCredentials = vi.fn(async () => {
      order.push('clear');
    });
    const subject = actor(
      async () => client(undefined, close),
      linearId,
      vi.fn(),
      'authentication-required',
      clearCredentials
    );

    await subject.connect();
    await expect(subject.disconnect()).resolves.toMatchObject({
      state: 'authentication-required',
    });
    expect(order).toEqual(['close', 'clear']);

    const ordinaryClear = vi.fn(async () => undefined);
    const ordinary = actor(
      async () => client(),
      linearId,
      vi.fn(),
      'authentication-required',
      ordinaryClear
    );
    await ordinary.connect();
    await ordinary.close();
    expect(ordinaryClear).not.toHaveBeenCalled();
  });
  it('cancels explicit Connect after background authorization hands off to a new attempt', async () => {
    const background = deferred<McpServerActorClient>();
    const interactive = deferred<McpServerActorClient>();
    const factory = vi.fn(
      ({ interactiveAuthorization }: Parameters<McpServerActorClientFactory>[0]) =>
        interactiveAuthorization ? interactive.promise : background.promise
    );
    const subject = actor(factory);
    const discovery = subject.invoke(LIST).catch((error: unknown) => error);
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    const connecting = subject.connect().catch((error: unknown) => error);
    background.reject(new McpLifecycleFailure('authentication', 'mcp-authentication-required'));
    await discovery;
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    await subject.cancel();
    const settled = vi.fn();
    void connecting.then(settled);
    try {
      await vi.waitFor(
        () => expect(settled).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' })),
        { timeout: 100 }
      );
    } finally {
      interactive.resolve(client());
      await connecting;
      await subject.close();
    }
  });

  it('does not let a cancelled old factory clear an immediate retry client', async () => {
    const oldFactory = deferred<McpServerActorClient>();
    const oldClose = vi.fn(async () => report);
    let factoryCalls = 0;
    const subject = actor(
      () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? oldFactory.promise : Promise.resolve(client());
      },
      linearId,
      vi.fn(),
      'authentication-required'
    );

    const firstConnect = subject.connect();
    await vi.waitFor(() => expect(subject.snapshot().state).toBe('authorizing'));
    await expect(subject.cancel()).resolves.toMatchObject({ state: 'authentication-required' });

    const retry = subject.connect();
    await expect(retry).resolves.toMatchObject({ state: 'connected' });
    oldFactory.resolve(client(undefined, oldClose));
    await expect(firstConnect).rejects.toBeDefined();
    await vi.waitFor(() => expect(oldClose).toHaveBeenCalledOnce());
    expect(subject.snapshot().state).toBe('connected');
  });
  it('publishes accepted work and one client promise before factory reentry', async () => {
    const invoke = vi.fn(client().invoke);
    let reentered: Promise<McpHostOperationResult> = Promise.resolve(callResult);
    let subject: McpServerActor;
    const factory = vi.fn(() => {
      reentered = subject.invoke(CALL);
      return client(invoke);
    });
    subject = actor(factory);
    const requests = Array.from({ length: 10 }, (_, index) =>
      subject.invoke(index < 5 ? LIST : CALL)
    );
    const results = await Promise.all([...requests, reentered]);
    expect(factory).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(11);
    expect(results).toContainEqual(listResult);
    expect(results).toContainEqual(callResult);
    expect(subject.snapshot().state).toBe('connected');
    expect(await subject.close()).toEqual(report);
  });
  it('retires accepted leases distinctly from caller cancellation', async () => {
    const retirementHeld = deferred<unknown>();
    const closeClient = vi.fn(async () => report);
    const invoke = vi.fn(() => retirementHeld.promise);
    const subject = actor(({ signal }) => {
      expect(signal.aborted).toBe(false);
      return client(invoke, closeClient);
    });
    const active = subject.invoke(LIST);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const closing = subject.close();
    await failure(active, 'mcp_generation_retired');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(closeClient).not.toHaveBeenCalled();
    retirementHeld.resolve(listResult.result);
    await expect(closing).resolves.toEqual(report);
    expect(closeClient).toHaveBeenCalledOnce();
    await failure(subject.invoke(LIST), 'mcp_generation_retired');

    const caller = new AbortController();
    const callerReason = new DOMException('caller stopped', 'AbortError');
    const callerHeld = deferred<unknown>();
    const callerInvoke = vi.fn((_request, options) => {
      options.signal.addEventListener('abort', () => callerHeld.reject(options.signal.reason), {
        once: true,
      });
      return callerHeld.promise;
    });
    const callerActor = actor(() => client(callerInvoke));
    const callerWork = callerActor.invoke(LIST, { signal: caller.signal });
    caller.abort(callerReason);
    await expect(callerWork).rejects.toBe(callerReason);
    expect(callerActor.invalidated()).toBe(false);

    const lazyFactory = vi.fn(async () => client());
    await actor(lazyFactory).close();
    expect(lazyFactory).not.toHaveBeenCalled();
    const pendingFactory = deferred<McpServerActorClient>();
    const pendingClose = vi.fn(async () => report);
    const pendingActor = actor(() => pendingFactory.promise);
    const pendingInvoke = pendingActor.invoke(LIST);
    await Promise.resolve();
    const pendingDrain = pendingActor.close();
    pendingFactory.resolve(client(undefined, pendingClose));
    await failure(pendingInvoke, 'mcp_generation_retired');
    await expect(pendingDrain).resolves.toEqual(report);
    expect(pendingClose).toHaveBeenCalledOnce();
  });

  it('invalidates one generation when its owned transport closes unexpectedly', async () => {
    const raw = new Error('triggering transport failure');
    let invalidate: () => void = vi.fn();
    const subject = actor((context) => {
      invalidate = context.onUnexpectedClose;
      return client(async () => {
        invalidate();
        throw raw;
      });
    });
    await failure(subject.invoke(LIST), 'mcp-transport-operation-failed');
    expect(subject.invalidated()).toBe(true);
    expect(subject.snapshot()).toMatchObject({ error: { code: 'mcp-transport-closed' } });
    await failure(subject.invoke(LIST), 'mcp_generation_retired');
  });

  it('adopts a client whose transport closed mid-handshake so close still reaps it', async () => {
    const closed = vi.fn(async () => report);
    const subject = actor((context) => {
      // BST-1600: a stdio child that exits while the handshake is still running
      // records the lifecycle failure BEFORE the client factory returns.
      context.onUnexpectedClose();
      return client(undefined, closed);
    });

    await failure(subject.invoke(LIST), 'mcp-transport-closed');
    // `change` is an unconditional single writer, so a successful handshake
    // must not publish `connected` over the recorded failure.
    expect(subject.snapshot()).toMatchObject({
      error: { code: 'mcp-transport-closed' },
      state: 'error',
    });
    // Ownership precedes the rethrow: the client the factory returned is the
    // actor's, so close reaps it instead of orphaning the child behind it.
    await expect(subject.close()).resolves.toEqual(report);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('sanitizes and memoizes every actor boundary failure', async () => {
    const raw = new Error('credential-value-must-never-cross');
    const factoryActor = actor(() => Promise.reject(raw));
    const failures = await Promise.all(
      Array.from({ length: 5 }, () =>
        failure(factoryActor.invoke(LIST), 'mcp-client-creation-failed')
      )
    );
    expect(new Set(failures).size).toBe(1);
    const invalidResult = structuredClone(listResult.result);
    Reflect.set(invalidResult, 'invalid', () => raw);
    const transport = actor(async () => client(async () => Promise.reject(raw)));
    const clone = actor(async () => client(async () => invalidResult));
    const mismatch = actor(async () => client());
    const cases = [
      [transport, LIST, 'mcp-transport-operation-failed'],
      [clone, LIST, 'mcp-result-invalid'],
      [mismatch, { ...LIST, configuredServerId: githubId }, 'mcp-configured-server-mismatch'],
    ] as const;
    for (const [subject, request, code] of cases) {
      await failure(subject.invoke(request), code);
    }
    const internalError = vi.fn();
    const closeActor = actor(
      async () => client(undefined, async () => Promise.reject(raw)),
      linearId,
      internalError
    );
    await closeActor.invoke(LIST);
    const closing = closeActor.close();
    expect(closeActor.close()).toBe(closing);
    await expect(closing).resolves.toEqual({
      callbacksClosed: 0,
      childProcessesClosed: 0,
      clientsClosed: 0,
      failures: [
        {
          category: 'transport',
          code: 'mcp-client-close-failed',
          message: 'MCP server actor operation failed',
        },
      ],
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    });
    expect(internalError).toHaveBeenCalledWith('mcp-client-close-failed', raw);
    expect(closeActor.snapshot()).toMatchObject({
      error: { code: 'mcp-client-close-failed' },
      state: 'error',
    });
    await failure(closeActor.invoke(LIST), 'mcp_generation_retired');
    const invalid = structuredClone(negotiated);
    Reflect.set(invalid, 'invalid', () => undefined);
    const closeClient = vi.fn(async () => report);
    const subject = actor(async () => client(undefined, closeClient, invalid));
    const first = await failure(subject.invoke(LIST), 'mcp-negotiated-status-invalid');
    expect(await failure(subject.invoke(LIST), 'mcp-negotiated-status-invalid')).toBe(first);
    await subject.close();
    expect(closeClient).toHaveBeenCalledOnce();

    const malformed = structuredClone(negotiated);
    Reflect.set(malformed, 'advertisedCapabilityIds', {});
    const malformedClose = vi.fn(async () => report);
    const malformedActor = actor(async () => client(undefined, malformedClose, malformed));
    await failure(malformedActor.invoke(LIST), 'mcp-negotiated-status-invalid');
    await malformedActor.close();
    expect(malformedClose).toHaveBeenCalledOnce();

    const nonJson = structuredClone(negotiated);
    Reflect.set(nonJson, 'serverIdentity', {
      description: undefined,
      name: 'test-server',
      version: '1.0.0',
    });
    await failure(
      actor(async () => client(undefined, undefined, nonJson)).invoke(LIST),
      'mcp-negotiated-status-invalid'
    );
  });
  it('keeps cleanup and close failures visible without rejecting terminal close', async () => {
    const raw = new Error('private cleanup failure');
    const invalid = structuredClone(negotiated);
    Reflect.set(invalid, 'advertisedCapabilityIds', {});
    const internalError = vi.fn();
    const subject = actor(
      async () => client(undefined, async () => Promise.reject(raw), invalid),
      linearId,
      internalError
    );

    await failure(subject.invoke(LIST), 'mcp-negotiated-status-cleanup-failed');
    const closing = subject.close();
    expect(subject.close()).toBe(closing);
    await expect(closing).resolves.toMatchObject({
      failures: [{ code: 'mcp-client-close-failed' }],
    });
    expect(subject.snapshot()).toMatchObject({
      error: { code: 'mcp-negotiated-status-cleanup-failed' },
      state: 'error',
    });
    expect(internalError).toHaveBeenCalledWith('mcp-client-close-failed', raw);

    const malformedReport = structuredClone(report);
    Reflect.set(malformedReport, 'clientsClosed', -1);
    const malformedActor = actor(async () => client(undefined, async () => malformedReport));
    await malformedActor.invoke(LIST);
    await expect(malformedActor.close()).resolves.toMatchObject({
      failures: [{ code: 'mcp-client-close-report-invalid' }],
    });
    expect(malformedActor.snapshot()).toMatchObject({
      error: { code: 'mcp-client-close-report-invalid' },
      state: 'error',
    });

    const rawReportedFailure = {
      category: 'transport' as const,
      code: 'sdk-client-close-failed',
      message: 'Authorization: Bearer credential-value-must-never-cross',
    };
    const reportedInternalError = vi.fn();
    const reportedActor = actor(
      async () =>
        client(undefined, async () => ({
          ...report,
          failures: [rawReportedFailure],
        })),
      linearId,
      reportedInternalError
    );
    await reportedActor.invoke(LIST);
    const reportedClose = await reportedActor.close();
    expect(reportedClose).toEqual({
      ...report,
      failures: [
        {
          category: 'transport',
          code: 'mcp-client-close-reported-failures',
          message: 'MCP server actor operation failed',
        },
      ],
    });
    expect(JSON.stringify(reportedClose)).not.toContain('credential-value-must-never-cross');
    expect(reportedInternalError).toHaveBeenCalledWith('mcp-client-close-reported-failures', {
      ...report,
      failures: [rawReportedFailure],
    });
  });
  it('preserves a client close report with zero settled requests', async () => {
    const close = vi.fn(async () => ({ ...report, requestsSettled: 0 }));
    const subject = actor(async () => client(undefined, close));
    await subject.invoke(LIST);

    await expect(subject.close()).resolves.toMatchObject({ requestsSettled: 0 });
    expect(close).toHaveBeenCalledOnce();
  });
  it('latches failed client cleanup when retirement wins factory failure', async () => {
    const connecting = deferred<McpServerActorClient>();
    const internalError = vi.fn();
    const subject = actor(async () => await connecting.promise, linearId, internalError);
    const invocation = subject.invoke(LIST);
    await vi.waitFor(() => expect(subject.snapshot().state).toBe('connecting'));
    const closing = subject.close();
    await failure(invocation, 'mcp_generation_retired');
    connecting.reject(
      new McpServerActorClientCleanupError(
        [new Error('connect failed'), new Error('cleanup failed')],
        'MCP client operation failed and cleanup also failed'
      )
    );
    await expect(closing).resolves.toMatchObject({
      failures: [{ code: 'mcp-client-creation-cleanup-failed' }],
    });
    expect(internalError).toHaveBeenCalledWith(
      'mcp-client-creation-failed',
      expect.objectContaining({ errors: [expect.any(Error), expect.any(Error)] })
    );
  });
  it('returns immutable close reports without sharing mutable empty failures', async () => {
    const first = await actor(async () => client()).close();
    const second = await actor(async () => client()).close();

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.failures)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.failures).not.toBe(second.failures);
  });
  it('uses the close report as completion proof while preserving a connected actor failure', async () => {
    const events: unknown[] = [];
    const closeClient = vi.fn(async () => report);
    const invalidResult = structuredClone(listResult.result);
    Reflect.set(invalidResult, 'invalid', () => undefined);
    const subject = new McpServerActor({
      ...base(linearId),
      factory: async () => client(async () => invalidResult, closeClient),
      onInternalError: vi.fn(),
      onSnapshotChanged: (snapshot) => events.push(snapshot),
      startup: 'automatic',
    });

    await failure(subject.invoke(LIST), 'mcp-result-invalid');
    const closeReport = await subject.close();

    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeReport).toEqual(report);
    expect(subject.snapshot()).toMatchObject({
      error: { code: 'mcp-result-invalid' },
      state: 'error',
    });
    expect(events).toEqual([
      { ...base(linearId), state: 'connecting' },
      { ...base(linearId), negotiated, state: 'connected' },
      {
        ...base(linearId),
        error: {
          category: 'protocol',
          code: 'mcp-result-invalid',
          message: 'MCP server actor operation failed',
        },
        state: 'error',
      },
    ]);
  });
  it('isolates snapshot observer failures from invocation and close', async () => {
    const raw = new Error('observer-private-detail');
    const internalError = vi.fn();
    const subject = new McpServerActor({
      ...base(linearId),
      factory: async () => client(),
      onInternalError: internalError,
      onSnapshotChanged: () => {
        throw raw;
      },
      startup: 'automatic',
    });

    await expect(subject.invoke(LIST)).resolves.toEqual(listResult);
    await expect(subject.close()).resolves.toEqual(report);
    expect(internalError).toHaveBeenCalledWith('mcp-snapshot-listener-failed', raw);
  });
  it('emits detached snapshots once per exact transition and isolates actors', async () => {
    const pending = deferred<McpServerActorClient>();
    const events: unknown[] = [];
    const invoke = vi.fn(client().invoke);
    const first = new McpServerActor({
      ...base(linearId),
      factory: () => pending.promise,
      onInternalError: vi.fn(),
      onSnapshotChanged: (snapshot) => events.push(snapshot),
      startup: 'automatic',
    });
    const second = actor(async () => client(), githubId);
    expect(first.snapshot()).toEqual({ ...base(linearId), state: 'disconnected' });
    const active = first.invoke(LIST);
    pending.resolve(client(invoke));
    await active;
    const connected = first.snapshot();
    if (connected.state === 'connected') {
      connected.negotiated.advertisedCapabilityIds?.push('mutated');
    }
    invoke.mockRejectedValueOnce(new Error('private transport detail'));
    const failed = await failure(first.invoke(CALL), 'mcp-transport-operation-failed');
    expect(await failure(first.invoke(LIST), 'mcp-transport-operation-failed')).toBe(failed);
    await first.close();
    expect(events).toEqual([
      { ...base(linearId), state: 'connecting' },
      { ...base(linearId), negotiated, state: 'connected' },
      {
        ...base(linearId),
        error: {
          category: 'transport',
          code: 'mcp-transport-operation-failed',
          message: 'MCP server actor operation failed',
        },
        state: 'error',
      },
    ]);
    await second.invoke({ ...LIST, configuredServerId: githubId });
    expect(second.snapshot()).toEqual({ ...base(githubId), negotiated, state: 'connected' });
  });
});
