import { createMcpElicitationCapability } from '@brainstrike/agent/mcp-client';
import {
  type McpHostServerSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpElicitationPresentation,
  McpElicitationPresenterAuthority,
  McpElicitationPresenterError,
} from '../../mcp/elicitation-presenter';

const SERVER_ID = parseConfiguredMcpServerId('team.linear.prod');
const connectedServer = (
  websiteUrl = 'https://linear.example/about?token=must-not-project'
): McpHostServerSnapshot => ({
  configuredProtocol: '2026-07-28',
  configuredServerId: SERVER_ID,
  generation: 7,
  negotiated: {
    era: 'modern',
    revision: '2026-07-28',
    serverIdentity: {
      name: 'Linear MCP',
      title: 'Linear',
      version: '2.0.0',
      websiteUrl,
    },
  },
  state: 'connected',
  transport: 'streamable-http',
});
const formRequest = {
  method: 'elicitation/create',
  params: {
    message: 'Choose a workspace',
    mode: 'form',
    requestedSchema: {
      properties: { workspace: { type: 'string' } },
      required: ['workspace'],
      type: 'object',
    },
  },
} satisfies ElicitRequest;
const context = (requestId: string, signal = new AbortController().signal) => ({
  requestId,
  serverName: SERVER_ID,
  signal,
});
const settlement = (id: string | undefined, requestId: string) => ({
  configuredServerId: SERVER_ID,
  generation: 7,
  id,
  requestId,
});

describe('McpElicitationPresenterAuthority', () => {
  it('reports every finalization to bounded, non-throwing observers', async () => {
    let sequence = 1;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `presentation-${sequence++}`,
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach(() => undefined);
    const events: unknown[] = [];
    const stopObserving = authority.observeFinalized((event) => events.push(event));
    const stopThrowing = authority.observeFinalized(() => {
      throw new Error('observer failure must not affect settlement');
    });
    const operation = { configuredServerId: SERVER_ID, type: 'tools/list' } as const;
    const settled = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, context('settle-me'))
    );
    authority.settle({
      action: 'accept',
      content: { workspace: 'Engineering' },
      ...settlement('presentation-1', 'settle-me'),
    });
    await expect(settled).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    const caller = new AbortController();
    const aborted = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, context('abort-me', caller.signal))
    );
    caller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'mcp-elicitation-caller-aborted' });
    expect(events).toEqual([
      { code: 'mcp-elicitation-already-settled', id: 'presentation-1' },
      { code: 'mcp-elicitation-caller-aborted', id: 'presentation-2' },
    ]);
    stopObserving();
    stopThrowing();
    const observers = [1, 2, 3, 4].map(() => authority.observeFinalized(() => undefined));
    expect(() => authority.observeFinalized(() => undefined)).toThrowError(
      expect.objectContaining({ code: 'mcp-elicitation-presenter-unavailable' })
    );
    for (const stop of observers) {
      stop();
    }
    const closing = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, context('close-me'))
    );
    const closingResult = expect(closing).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-closed',
    });
    authority.close();
    await closingResult;
    expect(events).toHaveLength(2);
    expect(() => authority.observeFinalized(() => undefined)).toThrowError(
      expect.objectContaining({ code: 'mcp-elicitation-presenter-closed' })
    );
  });

  it('rejects invalid or sensitive form data without consuming a correctable presentation', async () => {
    const presentations: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach((value) => presentations.push(value));
    const operation = { configuredServerId: SERVER_ID, type: 'tools/list' } as const;
    const pending = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, context('correctable'))
    );
    const accepted = {
      ...settlement(presentations[0]?.id, 'correctable'),
      action: 'accept' as const,
    };
    expect(() => authority.settle({ ...accepted, content: { workspace: 42 } })).toThrowError(
      expect.objectContaining({ code: 'mcp-elicitation-settlement-invalid' })
    );
    authority.settle({ ...accepted, content: { workspace: 'Engineering' } });
    await expect(pending).resolves.toMatchObject({ content: { workspace: 'Engineering' } });
    const invalidRequests: Parameters<typeof authority.presenter.presentForm>[0][] = [
      { ...formRequest, params: { ...formRequest.params, message: 'x'.repeat(33_000) } },
      {
        ...formRequest,
        params: { ...formRequest.params, requestedSchema: {} },
      } as unknown as Parameters<typeof authority.presenter.presentForm>[0],
    ];
    for (const invalidRequest of invalidRequests) {
      await expect(
        authority.runWithOperation(operation, () =>
          authority.presenter.presentForm(invalidRequest, context('sensitive'))
        )
      ).rejects.toMatchObject({ code: 'mcp-elicitation-request-invalid' });
    }
    expect(presentations).toHaveLength(1);
  });
  it('presents exact provenance and settles an accepted form exactly once', async () => {
    let server = connectedServer();
    let sequence = 0;
    let presentation: McpElicitationPresentation | undefined;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      openExternal: vi.fn(),
      resolveServer: () => server,
    });
    authority.attach((value) => {
      presentation = value;
    });
    const result = authority.runWithOperation(
      {
        arguments: { query: 'private model input' },
        configuredServerId: SERVER_ID,
        toolName: 'search_issues',
        type: 'tools/call',
      },
      () => authority.presenter.presentForm(formRequest, context('elicitation-1'))
    );
    expect(presentation).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      message: 'Choose a workspace',
      mode: 'form',
      provenance: {
        configuredProtocol: '2026-07-28',
        configuredServerId: SERVER_ID,
        generation: 7,
        invocationId: expect.any(String),
        negotiatedRevision: '2026-07-28',
        operation: { target: 'search_issues', type: 'tools/call' },
        requestId: 'elicitation-1',
        serverIdentity: {
          name: 'Linear MCP',
          title: 'Linear',
          version: '2.0.0',
          websiteOrigin: 'https://linear.example',
        },
        transport: 'streamable-http',
      },
      requestedSchema: formRequest.params.requestedSchema,
    });
    authority.settle({
      action: 'accept',
      content: { workspace: 'Engineering' },
      ...settlement(presentation?.id, 'elicitation-1'),
    });
    await expect(result).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    expect(() =>
      authority.settle({
        action: 'decline',
        ...settlement(presentation?.id, 'elicitation-1'),
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-already-settled' }));
    server = connectedServer('not a URL');
    const malformedIdentity = authority.runWithOperation(
      { configuredServerId: SERVER_ID, type: 'tools/list' },
      () => authority.presenter.presentForm(formRequest, context('malformed-identity'))
    );
    expect(presentation).not.toHaveProperty('provenance.serverIdentity.websiteOrigin');
    authority.settle({ action: 'cancel', ...settlement(presentation?.id, 'malformed-identity') });
    await malformedIdentity;
  });
  it('opens a safe URL only after an exact one-use accept decision', async () => {
    const presentations: McpElicitationPresentation[] = [];
    const openExternal = vi.fn(async () => undefined);
    let sequence = 1;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      openExternal,
      resolveServer: () => connectedServer(),
    });
    authority.attach((value) => presentations.push(value));
    const capability = createMcpElicitationCapability(authority.presenter);
    const operation = {
      configuredServerId: SERVER_ID,
      name: 'connect-account',
      type: 'prompts/get',
    } as const;
    const request = {
      method: 'elicitation/create',
      params: {
        elicitationId: 'third-party-connect',
        message: 'Connect your account',
        mode: 'url',
        url: 'https://accounts.example/connect?state=opaque&code_challenge=safe',
      },
    } satisfies ElicitRequest;
    const invoke = (requestId: string) =>
      authority.runWithOperation(operation, () => capability.handle(request, context(requestId)));
    const accepted = invoke('url-accept');
    expect(presentations[0]).toMatchObject({
      mode: 'url',
      url: request.params.url,
    });
    authority.settle({
      action: 'accept',
      ...settlement(presentations[0]?.id, 'url-accept'),
    });
    await expect(accepted).resolves.toEqual({ action: 'accept' });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(new URL(request.params.url));
    await expect(
      authority.runWithOperation(operation, () =>
        authority.presenter.openExternal(new URL(request.params.url), context('url-accept'))
      )
    ).rejects.toMatchObject({ code: 'mcp-elicitation-url-not-authorized' });
    for (const key of ['api_key', 'client_secret', 'session_token']) {
      await expect(
        authority.runWithOperation(operation, () =>
          authority.presenter.confirmUrl(
            { ...request, params: { ...request.params, url: `https://example.test/?${key}=x` } },
            context(key)
          )
        )
      ).rejects.toMatchObject({ code: 'mcp-elicitation-url-sensitive' });
    }
    const held = Promise.withResolvers<void>();
    const concurrent = [
      authority.runWithOperation(operation, () => held.promise),
      authority.runWithOperation(operation, () => held.promise),
    ];
    await expect(
      authority.presenter.confirmUrl(request, context('ambiguous'))
    ).rejects.toMatchObject({ code: 'mcp-elicitation-origin-unbound' });
    held.resolve();
    await Promise.all(concurrent);
    openExternal.mockRejectedValueOnce(new Error('opener failed'));
    const failedOpen = invoke('opener-failure');
    const failedPresentation = presentations.at(-1);
    authority.settle({
      action: 'accept',
      ...settlement(failedPresentation?.id, 'opener-failure'),
    });
    await expect(failedOpen).rejects.toThrow('opener failed');
  });
  it('bounds pending and finalized authority while rejecting generated-id collisions', async () => {
    const ids: string[] = [];
    const seen: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => ids.shift() ?? 'missing-id',
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    const attach = () => authority.attach((presentation) => seen.push(presentation));
    let detach = attach();
    const present = (id: string) => {
      ids.push(id);
      return authority.presenter.presentForm(formRequest, context(id));
    };
    await authority.runWithOperation(
      { configuredServerId: SERVER_ID, type: 'tools/list' },
      async () => {
        const pending = Array.from({ length: 32 }, (_, index) => present(`p${index}`));
        await expect(present('overflow')).rejects.toMatchObject({
          code: 'mcp-elicitation-pending-limit',
        });
        detach();
        expect(
          (await Promise.allSettled(pending)).every(({ status }) => status === 'rejected')
        ).toBe(true);
        detach = attach();
        for (let index = 0; index < 97; index++) {
          const result = present(`f${index}`);
          authority.settle({
            action: 'cancel',
            ...settlement(seen.at(-1)?.id, `f${index}`),
          });
          await result;
        }
        const reused = present('p0');
        await expect(present('p0')).rejects.toMatchObject({
          code: 'mcp-elicitation-id-collision',
        });
        detach();
        await expect(reused).rejects.toMatchObject({
          code: 'mcp-elicitation-presenter-unavailable',
        });
      }
    );
  });
  it('settles caller abort, authority retirement, close, and restart without resumable state', async () => {
    let server = connectedServer();
    const presentations: McpElicitationPresentation[] = [];
    let sequence = 10;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
      openExternal: vi.fn(),
      resolveServer: () => server,
    });
    authority.attach((value) => presentations.push(value));
    const operation = {
      configuredServerId: SERVER_ID,
      type: 'tools/list',
    } as const;
    const present = (requestId: string, signal: AbortSignal) =>
      authority.runWithOperation(operation, () =>
        authority.presenter.presentForm(formRequest, context(requestId, signal))
      );
    const caller = new AbortController();
    const aborted = present('abort-me', caller.signal);
    const abortedResult = expect(aborted).rejects.toMatchObject({
      code: 'mcp-elicitation-caller-aborted',
    });
    caller.abort();
    await abortedResult;
    const retired = present('retire-me', new AbortController().signal);
    const retiredId = presentations.at(-1)?.id;
    const retiredResult = expect(retired).rejects.toMatchObject({
      code: 'mcp-elicitation-authority-retired',
    });
    authority.retireServer(SERVER_ID, 7);
    await retiredResult;
    expect(() =>
      authority.settle({
        action: 'cancel',
        ...settlement(retiredId, 'retire-me'),
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-stale-authority' }));
    server = { ...connectedServer(), generation: 8 };
    const closing = present('close-me', new AbortController().signal);
    const closingId = presentations.at(-1)?.id;
    const closingResult = expect(closing).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-closed',
    });
    authority.close();
    await closingResult;
    const restarted = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => server,
    });
    expect(() =>
      restarted.settle({
        action: 'accept',
        configuredServerId: SERVER_ID,
        content: { workspace: 'stale' },
        generation: 8,
        id: closingId,
        requestId: 'close-me',
      })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-settlement-invalid' }));
  });
});

describe('McpElicitationPresenterAuthority host caller and awaited consent (BST-1930)', () => {
  const caller = { runId: 'run-1', threadId: 'thread-1', toolCallId: 'call-1' };
  const taskHandle = {
    authorityEpoch: '00000000-0000-4000-8000-000000000001',
    principalId: 'fixture-principal',
    resource: 'https://tasks.example.test/',
    serverId: SERVER_ID,
    taskId: 'pending-task',
  };

  it('carries the supplied host caller into operation and task provenance', async () => {
    let sequence = 1;
    const presentations: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `presentation-${sequence++}`,
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach((presentation) => presentations.push(presentation));
    const operation = {
      configuredServerId: SERVER_ID,
      toolName: 'search_issues',
      type: 'tools/call',
    } as const;
    const answer = (id: string, requestId: string): void =>
      authority.settle({ action: 'decline', ...settlement(id, requestId) });
    const called = authority.runWithOperation(
      operation,
      () => authority.presenter.presentForm(formRequest, context('called')),
      caller
    );
    answer('presentation-1', 'called');
    await expect(called).resolves.toEqual({ action: 'decline' });
    const uncalled = authority.runWithOperation(operation, () =>
      authority.presenter.presentForm(formRequest, context('uncalled'))
    );
    answer('presentation-2', 'uncalled');
    await expect(uncalled).resolves.toEqual({ action: 'decline' });
    const binding = authority.bindTaskPresenter({
      caller,
      configuredServerId: SERVER_ID,
      generation: 7,
      operation: { target: 'long_running_tool', type: 'tools/call' },
      taskHandle,
    });
    const task = binding.presenter.presentForm(formRequest, context('task-input'));
    answer('presentation-3', 'task-input');
    await expect(task).resolves.toEqual({ action: 'decline' });
    expect(presentations.map(({ provenance }) => provenance.caller)).toEqual([
      caller,
      undefined,
      caller,
    ]);
    expect(presentations[1]?.provenance).not.toHaveProperty('caller');
    authority.close();
  });

  it('refuses input whose awaited consent surface rejects, keeping a presenter code', async () => {
    let sequence = 1;
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `presentation-${sequence++}`,
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    const events: unknown[] = [];
    authority.observeFinalized((event) => events.push(event));
    const committed = Promise.withResolvers<void>();
    const refusals = [
      Promise.reject(new McpElicitationPresenterError('mcp-elicitation-origin-unbound')),
      Promise.reject(new Error('commit failed')),
      committed.promise,
    ];
    for (const refusal of refusals) {
      refusal.catch(() => undefined);
    }
    authority.attach(() => refusals.shift());
    const operation = { configuredServerId: SERVER_ID, type: 'tools/list' } as const;
    const present = (requestId: string) =>
      authority.runWithOperation(operation, () =>
        authority.presenter.presentForm(formRequest, context(requestId))
      );
    await expect(present('unbound')).rejects.toMatchObject({
      code: 'mcp-elicitation-origin-unbound',
    });
    await expect(present('unwritten')).rejects.toMatchObject({
      code: 'mcp-elicitation-presenter-unavailable',
    });
    expect(() =>
      authority.settle({ action: 'decline', ...settlement('presentation-1', 'unbound') })
    ).toThrowError(expect.objectContaining({ code: 'mcp-elicitation-origin-unbound' }));
    // A consent surface that committed stays answerable.
    const accepted = present('committed');
    committed.resolve();
    await Promise.resolve();
    authority.settle({
      action: 'accept',
      content: { workspace: 'Engineering' },
      ...settlement('presentation-3', 'committed'),
    });
    await expect(accepted).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    expect(events).toEqual([
      { code: 'mcp-elicitation-origin-unbound', id: 'presentation-1' },
      { code: 'mcp-elicitation-presenter-unavailable', id: 'presentation-2' },
      { code: 'mcp-elicitation-already-settled', id: 'presentation-3' },
    ]);
    authority.close();
  });
});

describe('McpElicitationPresenterAuthority task-scoped binding (BST-1566)', () => {
  const taskContext = (requestId: string) => ({
    ...context(requestId),
    inputKey: requestId,
    taskId: 'task-1',
  });

  it('cannot route a task-scoped elicitation through the operation registry', async () => {
    const authority = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach(() => undefined);
    // Outside any in-flight host operation the single-matching-operation
    // guard has nothing to bind to.
    await expect(
      authority.presenter.presentForm(formRequest, taskContext('input-1'))
    ).rejects.toMatchObject({ code: 'mcp-elicitation-origin-unbound' });
    authority.close();
  });

  it('binds task input to its own provenance while a tool call on the same server is in flight', async () => {
    let sequence = 1;
    const presentations: McpElicitationPresentation[] = [];
    const authority = new McpElicitationPresenterAuthority({
      createPresentationId: () => `presentation-${sequence++}`,
      openExternal: vi.fn(),
      resolveServer: () => connectedServer(),
    });
    authority.attach((presentation) => presentations.push(presentation));
    const binding = authority.bindTaskPresenter({
      configuredServerId: SERVER_ID,
      generation: 7,
      operation: { target: 'long_running_tool', type: 'tools/call' },
      taskHandle: {
        authorityEpoch: '00000000-0000-4000-8000-000000000001',
        principalId: 'fixture-principal',
        resource: 'https://tasks.example.test/',
        serverId: SERVER_ID,
        taskId: 'pending-task',
      },
    });
    let release: (() => void) | undefined;
    const toolCall = authority.runWithOperation(
      { configuredServerId: SERVER_ID, toolName: 'search_issues', type: 'tools/call' },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    // The task binding never consults the operation registry, so the concurrent
    // tools/call neither blocks it nor lends it a misattributed provenance.
    const taskInput = binding.presenter.presentForm(formRequest, taskContext('input-1'));
    await Promise.resolve();
    expect(presentations).toHaveLength(1);
    expect(presentations[0]?.provenance).toMatchObject({
      configuredServerId: SERVER_ID,
      generation: 7,
      operation: { target: 'long_running_tool', type: 'tools/call' },
      requestId: 'input-1',
      taskHandle: {
        authorityEpoch: '00000000-0000-4000-8000-000000000001',
        principalId: 'fixture-principal',
        resource: 'https://tasks.example.test/',
        serverId: SERVER_ID,
        taskId: 'pending-task',
      },
    });
    authority.settle({
      action: 'accept',
      content: { workspace: 'Engineering' },
      ...settlement('presentation-1', 'input-1'),
    });
    await expect(taskInput).resolves.toEqual({
      action: 'accept',
      content: { workspace: 'Engineering' },
    });
    release?.();
    await toolCall;
    // A replaced generation is a stale authority for the bound task presenter.
    const stale = new McpElicitationPresenterAuthority({
      openExternal: vi.fn(),
      resolveServer: () => ({ ...connectedServer(), generation: 8 }),
    });
    stale.attach(() => undefined);
    const staleBinding = stale.bindTaskPresenter({
      configuredServerId: SERVER_ID,
      generation: 7,
      operation: { type: 'tools/call' },
      taskHandle: {
        authorityEpoch: '00000000-0000-4000-8000-000000000001',
        principalId: 'fixture-principal',
        resource: 'https://tasks.example.test/',
        serverId: SERVER_ID,
        taskId: 'pending-task',
      },
    });
    expect(() =>
      authority.bindTaskPresenter({
        configuredServerId: SERVER_ID,
        generation: 7,
        operation: { type: 'tools/call' },
        taskHandle: {
          authorityEpoch: '00000000-0000-4000-8000-000000000001',
          principalId: 'fixture-principal',
          resource: 'https://tasks.example.test/',
          serverId: 'foreign-server',
          taskId: 'pending-task',
        },
      })
    ).toThrow(/stale/u);
    await expect(
      staleBinding.presenter.presentForm(formRequest, taskContext('input-2'))
    ).rejects.toMatchObject({ code: 'mcp-elicitation-stale-authority' });
    // Releasing the binding retires it: later presentations fail closed.
    binding.release();
    await expect(
      binding.presenter.presentForm(formRequest, taskContext('input-3'))
    ).rejects.toMatchObject({ code: 'mcp-elicitation-authority-retired' });
    authority.close();
    stale.close();
  });
});
