import {
  type McpHostOperationResult,
  type McpNegotiatedStatus,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  McpServerActor,
  type McpServerActorClient,
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
  onInternalError?: (code: string, cause: unknown) => void
): McpServerActor {
  return new McpServerActor({ ...base(id), factory, onInternalError });
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
  expect(error).toMatchObject({ code, message: 'MCP server actor operation failed' });
  expect(error).toHaveProperty('category', expect.any(String));
  expect(error).not.toHaveProperty('cause');
  return error;
}
describe('McpServerActor', () => {
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
  it('drains work when its factory synchronously closes the actor', async () => {
    const held = deferred<unknown>();
    const closeClient = vi.fn(async () => report);
    let closing: ReturnType<McpServerActor['close']> | undefined;
    let subject: McpServerActor;
    subject = actor(() => {
      closing = subject.close();
      return client(() => held.promise, closeClient);
    });
    const active = subject.invoke(LIST);
    await Promise.resolve();
    expect(closeClient).not.toHaveBeenCalled();
    held.resolve(listResult.result);
    await active;
    await expect(closing).resolves.toEqual(report);
    expect(closeClient).toHaveBeenCalledOnce();
    await failure(subject.invoke(LIST), 'mcp-generation-closed');
    const lazyFactory = vi.fn(async () => client());
    await actor(lazyFactory).close();
    expect(lazyFactory).not.toHaveBeenCalled();
    const pendingFactory = deferred<McpServerActorClient>();
    const pendingClose = vi.fn(async () => report);
    const pendingActor = actor(() => pendingFactory.promise);
    const pendingInvoke = pendingActor.invoke(LIST);
    const pendingDrain = pendingActor.close();
    pendingFactory.resolve(client(undefined, pendingClose));
    await pendingInvoke;
    await expect(pendingDrain).resolves.toEqual(report);
    expect(pendingClose).toHaveBeenCalledOnce();
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
      loopbackPortsClosed: 0,
      probesClosed: 0,
      requestsSettled: 0,
      subscriptionsClosed: 0,
    });
    expect(internalError).toHaveBeenCalledWith('mcp-client-close-failed', raw);
    await failure(closeActor.invoke(LIST), 'mcp-generation-closed');
    const invalid = structuredClone(negotiated);
    Reflect.set(invalid, 'invalid', () => undefined);
    const closeClient = vi.fn(async () => report);
    const subject = actor(async () => client(undefined, closeClient, invalid));
    const first = await failure(subject.invoke(LIST), 'mcp-negotiated-status-invalid');
    expect(await failure(subject.invoke(LIST), 'mcp-negotiated-status-invalid')).toBe(first);
    await subject.close();
    expect(closeClient).toHaveBeenCalledOnce();
  });
  it('emits detached snapshots once per exact transition and isolates actors', async () => {
    const pending = deferred<McpServerActorClient>();
    const events: unknown[] = [];
    const invoke = vi.fn(client().invoke);
    const first = new McpServerActor({
      ...base(linearId),
      factory: () => pending.promise,
      onSnapshotChanged: (snapshot) => events.push(snapshot),
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
      { ...base(linearId), state: 'disconnected' },
    ]);
    await second.invoke({ ...LIST, configuredServerId: githubId });
    expect(second.snapshot()).toEqual({ ...base(githubId), negotiated, state: 'connected' });
  });
});
