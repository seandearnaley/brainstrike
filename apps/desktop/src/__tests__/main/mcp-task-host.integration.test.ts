/**
 * McpDesktopTaskHost over a real PGlite store migrated by the production
 * runner (BST-1566). Env-sensitive (native PGlite, wall-clock polling), hence
 * the integration suffix.
 */
import {
  McpClientExtensionRegistry,
  registerMcpTasksWireContracts,
} from '@brainstrike/agent/mcp-client';
import type { McpClientExtensionRequestContract } from '@brainstrike/agent/mcp-tasks';
import type { McpTaskPresentation } from '@brainstrike/assistant-contract';
import { parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { McpTaskRepository, MigrationRunner, migrations, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';
import type { JSONObject } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  McpBoundTaskElicitationPresenter,
  McpTaskElicitationBinding,
} from '../../mcp/elicitation-presenter';
import {
  deriveMcpTaskAuthorityIdentity,
  MCP_STDIO_TASK_PRINCIPAL,
  MCP_STDIO_TASK_RESOURCE,
  McpDesktopTaskHost,
  type McpTaskConnection,
} from '../../mcp/task-host';
import type { ResolvedMcpServer } from '../../mcp-loader';

const SERVER_ID = parseConfiguredMcpServerId('team.tasks.prod');
const HTTP_SERVER: ResolvedMcpServer = {
  name: SERVER_ID,
  protocol: '2026-07-28',
  startup: 'automatic',
  transport: 'streamable-http',
  url: 'https://tasks.example.test/mcp#fragment',
};
const LIMITS = {
  initialPollMs: 10,
  maxBackoffMs: 20,
  maxConcurrentPolls: 2,
  maxLifetimeMs: 60_000,
  maxTransportFailures: 3,
  minimumPollMs: 5,
  pollRequestTimeoutMs: 5000,
} as const;

type TaskState =
  | { readonly status: 'working' }
  | { readonly inputRequests: Record<string, JSONObject>; readonly status: 'input_required' }
  | { readonly result: JSONObject; readonly status: 'completed' }
  | { readonly status: 'cancelled' };

/** A minimal task server: authoritative `tasks/get`, recorded update/cancel. */
function createFakeServer() {
  const states = new Map<string, TaskState>();
  const updates: JSONObject[] = [];
  const cancels: string[] = [];
  const listened: string[][] = [];
  type NotificationHandler = Parameters<McpTaskConnection['client']['listenTasks']>[1];
  let notify: NotificationHandler | undefined;
  let leaseClosed = false;
  const snapshot = (taskId: string): JSONObject => {
    const state = states.get(taskId);
    if (!state) {
      throw new Error(`unknown task ${taskId}`);
    }
    return {
      createdAt: '2026-09-01T05:00:00.000Z',
      lastUpdatedAt: new Date().toISOString(),
      pollIntervalMs: 10,
      taskId,
      ttlMs: 60_000,
      ...state,
    };
  };
  const client: McpTaskConnection['client'] = {
    getNegotiatedProtocolVersion: () => '2026-07-28',
    getServerCapabilities: () => ({ extensions: { 'io.modelcontextprotocol/tasks': {} } }),
    listenTasks: async (taskIds, handler) => {
      listened.push([...taskIds]);
      notify = handler;
      return {
        close: async () => {
          leaseClosed = true;
        },
        closed: new Promise<'graceful' | 'local' | 'remote'>(() => undefined),
        honoredTaskIds: [...taskIds],
      };
    },
    requestExtension: async <Params extends JSONObject, Result>(
      contract: McpClientExtensionRequestContract<Params, Result>,
      params: Params
    ): Promise<Result> => {
      const taskId = String(params['taskId']);
      switch (contract.method) {
        case 'tasks/get':
          return { ...snapshot(taskId), resultType: 'complete' } as Result;
        case 'tasks/update':
          updates.push(structuredClone(params));
          states.set(taskId, { result: { answered: true }, status: 'completed' });
          return { resultType: 'complete' } as Result;
        case 'tasks/cancel':
          cancels.push(taskId);
          states.set(taskId, { status: 'cancelled' });
          return { resultType: 'complete' } as Result;
        default:
          throw new Error(`unexpected ${contract.method}`);
      }
    },
  };
  return {
    cancels,
    client,
    created(taskId: string) {
      states.set(taskId, { status: 'working' });
      return {
        createdAt: '2026-09-01T05:00:00.000Z',
        lastUpdatedAt: '2026-09-01T05:00:00.000Z',
        pollIntervalMs: 10,
        resultType: 'task' as const,
        status: 'working' as const,
        statusMessage: 'Queued',
        taskId,
        ttlMs: 60_000,
      };
    },
    leaseClosed: () => leaseClosed,
    listened,
    notify: (taskId: string) => notify?.(snapshot(taskId) as Parameters<NotificationHandler>[0]),
    set: (taskId: string, state: TaskState) => states.set(taskId, state),
    updates,
  };
}

function createConnection(
  server: ReturnType<typeof createFakeServer>,
  patch: Partial<McpTaskConnection> = {}
): McpTaskConnection {
  const registry = new McpClientExtensionRegistry();
  registerMcpTasksWireContracts(registry);
  return {
    client: server.client,
    configRef: 'ref-1',
    configuredServerId: SERVER_ID,
    generation: 1,
    registry,
    server: HTTP_SERVER,
    ...patch,
  };
}

const bindings: McpTaskElicitationBinding[] = [];
const elicitationPresenter = {
  bindTaskPresenter: vi.fn(
    (binding: McpTaskElicitationBinding): McpBoundTaskElicitationPresenter => {
      bindings.push(binding);
      return {
        presenter: {
          confirmUrl: async () => ({ action: 'cancel' as const }),
          form: true,
          openExternal: async () => undefined,
          presentForm: async () => ({ action: 'accept' as const, content: { workspace: 'Eng' } }),
          url: true,
        },
        release: vi.fn(),
      };
    }
  ),
};

let db: PGlite;
let host: McpDesktopTaskHost;
const internalErrors: [string, unknown][] = [];
const changes: McpTaskPresentation[] = [];

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  db = await wasmLoader.createPGlite(`memory://mcp-task-host-${Date.now()}-${Math.random()}`);
  const runner = new MigrationRunner(db);
  await runner.initialize();
  await runner.up(migrations);
  internalErrors.length = 0;
  changes.length = 0;
  bindings.length = 0;
  host = new McpDesktopTaskHost({
    elicitationPresenter,
    lifecycleLimits: LIMITS,
    onInternalError: (code, cause) => internalErrors.push([code, cause]),
    openDatabase: async () => db,
    runtimeId: 'test-runtime',
  });
  host.subscribe((task) => changes.push(task));
});

afterEach(async () => {
  await host.close();
  await db.close();
  vi.clearAllMocks();
});

describe('deriveMcpTaskAuthorityIdentity', () => {
  it('derives the canonical resource and auth principal per transport', () => {
    expect(deriveMcpTaskAuthorityIdentity(HTTP_SERVER)).toEqual({
      principalId: 'none',
      resource: 'https://tasks.example.test/mcp',
    });
    expect(
      deriveMcpTaskAuthorityIdentity({
        ...HTTP_SERVER,
        auth: {
          credential: { id: '00000000-0000-4000-8000-000000000042', store: 'mcp-credentials' },
          type: 'bearer',
        },
      })
    ).toMatchObject({ principalId: 'bearer:00000000-0000-4000-8000-000000000042' });
    expect(
      deriveMcpTaskAuthorityIdentity({
        ...HTTP_SERVER,
        auth: { scopes: ['write', 'read'], type: 'oauth-user' },
        startup: 'authentication-required',
      })
    ).toMatchObject({ principalId: 'oauth-user:https://tasks.example.test/mcp|read write' });
    expect(
      deriveMcpTaskAuthorityIdentity({
        command: '/usr/local/bin/tasks',
        name: SERVER_ID,
        protocol: '2026-07-28',
        startup: 'automatic',
        transport: 'stdio',
      })
    ).toEqual({ principalId: MCP_STDIO_TASK_PRINCIPAL, resource: MCP_STDIO_TASK_RESOURCE });
    expect(() =>
      deriveMcpTaskAuthorityIdentity({ ...HTTP_SERVER, protocol: 'legacy', transport: 'sse' })
    ).toThrow(/not registered on the legacy sse transport/u);
  });
});

describe('McpDesktopTaskHost', () => {
  it('refuses a connection whose registry never registered Tasks', async () => {
    const server = createFakeServer();
    await expect(
      host.connected(createConnection(server, { registry: new McpClientExtensionRegistry() }))
    ).rejects.toThrow(/without the MCP Tasks extension registered/u);
  });

  it('opens no session for a server that does not advertise Tasks and refuses track()', async () => {
    const server = createFakeServer();
    server.client.getServerCapabilities = () => ({});
    await host.connected(createConnection(server));
    expect(host.snapshot().sessions).toEqual([]);
    await expect(
      host.track({ configuredServerId: SERVER_ID, result: server.created('t-1'), toolName: 'run' })
    ).rejects.toThrow(/has no live MCP Tasks session/u);
    await host.disconnected(SERVER_ID, 1);
  });

  it('tracks a task to settlement, bounds the wait, and lists the live presentation', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const initial = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-1'),
      toolName: 'long_job',
    });
    expect(initial).toMatchObject({
      handle: {
        principalId: 'none',
        resource: 'https://tasks.example.test/mcp',
        serverId: SERVER_ID,
        taskId: 't-1',
      },
      recovery: 'live',
      status: 'working',
    });
    expect(bindings).toEqual([
      {
        configuredServerId: SERVER_ID,
        generation: 1,
        operation: { target: 'long_job', type: 'tools/call' },
        taskHandle: initial.handle,
      },
    ]);
    expect(server.listened).toEqual([['t-1']]);
    await expect(host.awaitSettlement(initial.handle, { timeoutMs: 30 })).resolves.toEqual({
      reason: 'timeout',
      settled: false,
      task: expect.objectContaining({ status: 'working' }),
    });
    server.set('t-1', { result: { ok: true }, status: 'completed' });
    await server.notify('t-1');
    const outcome = await host.awaitSettlement(initial.handle, { timeoutMs: 5000 });
    expect(outcome).toEqual({
      settled: true,
      task: expect.objectContaining({
        canCancel: false,
        recovery: 'terminal',
        status: 'completed',
      }),
    });
    expect(host.list().tasks).toEqual([outcome.task]);
    expect(changes.at(-1)).toEqual(outcome.task);
    // A settled task answers again without a live poller.
    await expect(host.awaitSettlement(initial.handle, { timeoutMs: 10 })).resolves.toEqual(outcome);
    await expect(
      host.awaitSettlement({ ...initial.handle, taskId: 'unknown' }, { timeoutMs: 10 })
    ).rejects.toThrow(/unknown to this host/u);
    await until(() => host.snapshot().sessions[0]?.tasks === 0, 'task entry release');
    expect(internalErrors).toEqual([]);
  });

  it('answers mid-flight input through the task-scoped presenter and tasks/update', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const initial = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-2'),
      toolName: 'ask',
    });
    server.set('t-2', {
      inputRequests: {
        'input-1': {
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
        },
      },
      status: 'input_required',
    });
    const outcome = await host.awaitSettlement(initial.handle, { timeoutMs: 5000 });
    expect(outcome.settled).toBe(true);
    expect(server.updates).toEqual([
      {
        inputResponses: { 'input-1': { action: 'accept', content: { workspace: 'Eng' } } },
        taskId: 't-2',
      },
    ]);
    expect(changes.map((task) => task.status)).toContain('input_required');
    expect(internalErrors).toEqual([]);
  });

  it('cancels through the presentation controller and fences a stale handle', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const initial = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-3'),
      toolName: 'slow',
    });
    const result = await host.act({ action: 'cancel', handle: initial.handle });
    expect(result).toEqual({
      ok: true,
      task: expect.objectContaining({ canCancel: false, status: 'cancelled' }),
    });
    expect(server.cancels).toEqual(['t-3']);
    await expect(
      host.act({
        action: 'cancel',
        handle: { ...initial.handle, authorityEpoch: '00000000-0000-7000-8000-000000000000' },
      })
    ).resolves.toEqual({
      diagnostic: expect.objectContaining({ code: 'stale_handle' }),
      ok: false,
    });
    await expect(
      host.act({
        action: 'recover',
        handle: { ...initial.handle, serverId: 'other.server' },
      })
    ).resolves.toEqual({
      diagnostic: expect.objectContaining({ code: 'capability_removed' }),
      ok: false,
    });
  });

  it('recovers one card while another task on the same server is live', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const live = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-live'),
      toolName: 'long',
    });
    // A durable active row this host does not track (written by another
    // runtime, or whose earlier poller was lost): only recovery can resume it.
    const repository = new McpTaskRepository(db);
    const untracked = await repository.create(
      {
        ...live.handle,
        inputMetadata: {
          lifecycle: {
            createdAt: '2026-09-01T05:00:00.000Z',
            lastUpdatedAt: '2026-09-01T05:00:00.000Z',
            pollIntervalMs: 10,
            ttlMs: 60_000,
          },
        },
        status: 'working',
        taskId: 't-untracked',
      },
      {
        authorityEpoch: live.handle.authorityEpoch,
        connectionGeneration: 1,
        principalId: live.handle.principalId,
        resource: live.handle.resource,
        runtimeId: 'test-runtime',
        serverId: live.handle.serverId,
      }
    );
    server.set('t-untracked', { status: 'working' });
    expect(host.snapshot().sessions[0]).toMatchObject({ tasks: 1 });

    await expect(
      host.act({ action: 'recover', handle: { ...live.handle, taskId: untracked.taskId } })
    ).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ recovery: 'live', status: 'working' }),
    });
    expect(host.snapshot().sessions[0]).toMatchObject({ tasks: 2 });
    expect(host.snapshot().sessions[0]?.lifecycle.activeTasks).toBe(2);
    // The live task kept its original registration and settles normally.
    server.set('t-live', { result: { ok: true }, status: 'completed' });
    await expect(host.awaitSettlement(live.handle, { timeoutMs: 2000 })).resolves.toMatchObject({
      settled: true,
      task: expect.objectContaining({ status: 'completed' }),
    });
    expect(internalErrors).toEqual([]);
  });

  it('fences pending input without tasks/cancel when its tracking caller stops, then recovers it', async () => {
    const server = createFakeServer();
    const presented: AbortSignal[] = [];
    // The first binding's user never answers; the recovered binding accepts.
    elicitationPresenter.bindTaskPresenter.mockImplementationOnce(
      (binding: McpTaskElicitationBinding) => {
        bindings.push(binding);
        return {
          presenter: {
            confirmUrl: async () => ({ action: 'cancel' as const }),
            form: true,
            openExternal: async () => undefined,
            presentForm: (_request, context) => {
              presented.push(context.signal);
              return new Promise(() => undefined);
            },
            url: true,
          },
          release: vi.fn(),
        };
      }
    );
    await host.connected(createConnection(server));
    const caller = new AbortController();
    const initial = await host.track(
      { configuredServerId: SERVER_ID, result: server.created('t-6'), toolName: 'stoppable' },
      caller.signal
    );
    server.set('t-6', {
      inputRequests: {
        'input-1': {
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
        },
      },
      status: 'input_required',
    });
    await until(() => presented.length === 1, 'the input presentation');
    expect(host.list().tasks).toEqual([
      expect.objectContaining({
        handle: initial.handle,
        recovery: 'live',
        status: 'input_required',
      }),
    ]);

    const stopped = new Error('Run stopped by user');
    caller.abort(stopped);
    await until(() => internalErrors.length > 0, 'the tracking loss');

    expect(presented[0]?.aborted).toBe(true);
    expect(server.cancels).toEqual([]);
    expect(server.updates).toEqual([]);
    expect(host.list().tasks).toEqual([
      expect.objectContaining({
        handle: initial.handle,
        recovery: 'restart_required',
        status: 'input_required',
      }),
    ]);
    expect(internalErrors).toEqual([
      ['mcp-task-settlement-failed', { cause: stopped, taskId: 't-6' }],
    ]);
    // Recovery is the visible path: the input is presented again and answered.
    await expect(host.act({ action: 'recover', handle: initial.handle })).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ handle: initial.handle, status: 'input_required' }),
    });
    await expect(host.awaitSettlement(initial.handle, { timeoutMs: 5000 })).resolves.toEqual({
      settled: true,
      task: expect.objectContaining({ recovery: 'terminal', status: 'completed' }),
    });
    expect(server.updates).toEqual([
      {
        inputResponses: { 'input-1': { action: 'accept', content: { workspace: 'Eng' } } },
        taskId: 't-6',
      },
    ]);
    expect(server.cancels).toEqual([]);
  });

  it('recovers from inside the restart_required notification with a fresh poller and fresh input', async () => {
    const server = createFakeServer();
    const parked = Promise.withResolvers<void>();
    // The admitting run's user never answers; the recovered binding accepts.
    elicitationPresenter.bindTaskPresenter.mockImplementationOnce(
      (binding: McpTaskElicitationBinding) => {
        bindings.push(binding);
        return {
          presenter: {
            confirmUrl: async () => ({ action: 'cancel' as const }),
            form: true,
            openExternal: async () => undefined,
            presentForm: () => {
              parked.resolve();
              return new Promise(() => undefined);
            },
            url: true,
          },
          release: vi.fn(),
        };
      }
    );
    await host.connected(createConnection(server));
    const caller = new AbortController();
    const initial = await host.track(
      { configuredServerId: SERVER_ID, result: server.created('t-9'), toolName: 'stoppable' },
      caller.signal
    );
    server.set('t-9', {
      inputRequests: {
        'input-1': {
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
        },
      },
      status: 'input_required',
    });
    await parked.promise;
    // The subscriber recovers synchronously from the restart_required publication itself.
    const recovered = Promise.withResolvers<Awaited<ReturnType<typeof host.act>>>();
    host.subscribe((task) => {
      if (task.handle.taskId === 't-9' && task.recovery === 'restart_required') {
        host
          .act({ action: 'recover', handle: task.handle })
          .then(recovered.resolve, recovered.reject);
      }
    });
    caller.abort(new Error('Run stopped by user'));
    await expect(recovered.promise).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ handle: initial.handle, recovery: 'live' }),
    });
    expect(host.snapshot().sessions[0]).toMatchObject({ lifecycle: { activeTasks: 1 }, tasks: 1 });
    // The recovered poller presents the input afresh and its answer completes the task.
    await expect(host.awaitSettlement(initial.handle, { timeoutMs: 5000 })).resolves.toEqual({
      settled: true,
      task: expect.objectContaining({ recovery: 'terminal', status: 'completed' }),
    });
    expect(bindings.filter(({ taskHandle }) => taskHandle.taskId === 't-9')).toHaveLength(2);
    expect(server.updates).toEqual([
      {
        inputResponses: { 'input-1': { action: 'accept', content: { workspace: 'Eng' } } },
        taskId: 't-9',
      },
    ]);
    expect(server.cancels).toEqual([]);
  });

  it('binds a host-run task to Core and reports its input receipt from the update ack', async () => {
    const server = createFakeServer();
    const presented = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ action: 'accept'; content: { workspace: string } }>();
    elicitationPresenter.bindTaskPresenter.mockImplementationOnce(
      (binding: McpTaskElicitationBinding) => {
        bindings.push(binding);
        return {
          presenter: {
            confirmUrl: async () => ({ action: 'cancel' as const }),
            form: true,
            openExternal: async () => undefined,
            presentForm: () => {
              presented.resolve();
              return answer.promise;
            },
            url: true,
          },
          release: vi.fn(),
        };
      }
    );
    await host.connected(createConnection(server));
    const bound = Promise.withResolvers<void>();
    const execution = {
      bindTask: vi.fn((_task: { assertCurrent(): Promise<void> }) => bound.promise),
      requestInput: vi.fn(async () => undefined),
    };
    const initial = await host.track({
      configuredServerId: SERVER_ID,
      execution,
      result: server.created('t-host'),
      toolName: 'deploy',
    });
    // Core is asked to commit the exact handle; the registration stays current meanwhile.
    expect(execution.bindTask).toHaveBeenCalledWith({
      assertCurrent: expect.any(Function),
      handle: initial.handle,
    });
    await expect(execution.bindTask.mock.calls[0]?.[0].assertCurrent()).resolves.toBeUndefined();
    const binding = bindings.find(({ taskHandle }) => taskHandle.taskId === 't-host');
    expect(binding).toMatchObject({ host: { execution }, taskHandle: initial.handle });
    bound.resolve();
    await expect(binding?.host?.bound?.()).resolves.toBeUndefined();
    server.set('t-host', {
      inputRequests: {
        'input-1': {
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
        },
      },
      status: 'input_required',
    });
    await presented.promise;
    // The receipt is the server's ack of the update that carries this input's answer.
    const receipt = binding?.host?.acknowledged?.('input-1');
    answer.resolve({ action: 'accept', content: { workspace: 'Eng' } });
    await expect(receipt).resolves.toBeUndefined();
    expect(server.updates).toEqual([
      {
        inputResponses: { 'input-1': { action: 'accept', content: { workspace: 'Eng' } } },
        taskId: 't-host',
      },
    ]);
  });

  it('reports a binding Core refused instead of dropping it', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const refusal = new Error('Private MCP execution authority is unavailable or stale');
    await host.track({
      configuredServerId: SERVER_ID,
      execution: {
        bindTask: vi.fn(() => Promise.reject(refusal)),
        requestInput: vi.fn(async () => undefined),
      },
      result: server.created('t-refused'),
      toolName: 'deploy',
    });
    await vi.waitFor(() =>
      expect(internalErrors).toEqual([
        ['mcp-task-host-binding-refused', { cause: refusal, taskId: 't-refused' }],
      ])
    );
  });

  it('marks tasks restart_required on disconnect, recovers them on reconnect, and retires the epoch on replacement', async () => {
    const server = createFakeServer();
    await host.connected(createConnection(server));
    const initial = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-4'),
      toolName: 'resumable',
    });
    await host.disconnected(SERVER_ID, 1);
    expect(host.snapshot().sessions).toEqual([]);
    expect(server.leaseClosed()).toBe(true);
    expect(host.list().tasks).toEqual([
      expect.objectContaining({
        handle: initial.handle,
        recovery: 'restart_required',
        status: 'working',
      }),
    ]);
    await expect(host.awaitSettlement(initial.handle, { timeoutMs: 10 })).rejects.toThrow(
      /not tracked by a live MCP Tasks session/u
    );
    // Same definition, new host generation: the epoch rebinds and recovery is live.
    await host.connected(createConnection(server, { generation: 2 }));
    expect(host.snapshot().sessions[0]).toMatchObject({ generation: 2, tasks: 1 });
    expect(host.list().tasks).toEqual([
      expect.objectContaining({ handle: initial.handle, recovery: 'live' }),
    ]);
    expect(server.listened.at(-1)).toEqual(['t-4']);
    await expect(host.act({ action: 'recover', handle: initial.handle })).resolves.toEqual({
      ok: true,
      task: expect.objectContaining({ handle: initial.handle, status: 'working' }),
    });
    // A replaced definition retires the epoch: the old lease lists nothing.
    await host.retired(SERVER_ID, 'server-replaced');
    const repository = new McpTaskRepository(db);
    await expect(
      repository.listActive({
        authorityEpoch: initial.handle.authorityEpoch,
        connectionGeneration: 1,
        principalId: initial.handle.principalId,
        resource: initial.handle.resource,
        runtimeId: 'test-runtime',
        serverId: initial.handle.serverId,
      })
    ).resolves.toEqual([]);
    await host.connected(createConnection(server, { configRef: 'ref-2', generation: 3 }));
    const replacement = await host.track({
      configuredServerId: SERVER_ID,
      result: server.created('t-5'),
      toolName: 'fresh',
    });
    expect(replacement.handle.authorityEpoch).not.toBe(initial.handle.authorityEpoch);
    expect(internalErrors).toEqual([]);
  });
});
