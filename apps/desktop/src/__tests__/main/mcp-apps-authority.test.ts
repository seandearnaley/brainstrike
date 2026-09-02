import { EventEmitter } from 'node:events';
import type { McpAppToolAdmissionCapability } from '@brainstrike/agent';
import type { McpTaskTrackingRequest } from '@brainstrike/agent/mcp-tasks';
import {
  type McpAppPrepareRequest,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostServerSnapshot,
  type McpHostWatchEvent,
  type McpTaskPresentation,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import {
  type McpAppsExecutionHostPort,
  McpDesktopAppHost,
  type McpDesktopAppHostError,
} from '../../mcp/apps-authority';

class FakeWebContents extends EventEmitter {
  private destroyed = false;
  constructor(readonly id: number) {
    super();
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const THREAD_A = 'thread-a';
const THREAD_B = 'thread-b';

const request = (preparationId: string, threadId = THREAD_A): McpAppPrepareRequest => ({
  arguments: { title: 'Issue' },
  origin: {
    mimeType: 'text/html;profile=mcp-app',
    resourceUri: 'ui://linear/editor',
    serverId: 'linear',
    toolName: 'open_editor',
  },
  preparationId,
  threadId,
  toolName: 'create_issue',
});

function admission(
  text = 'ok',
  execute = vi.fn(async () => ({ content: [{ text, type: 'text' }] })),
  decision: 'allow' | 'ask' = 'allow',
  riskCategory: 'execute' | 'mcp' = 'mcp'
) {
  const capability: McpAppToolAdmissionCapability = {
    admit: vi.fn(() => ({ decision, execute, riskCategory })),
    appCapableToolCount: 1,
    inadmissibleTools: [],
    serverIds: ['linear'],
  };
  return { capability, execute };
}

const serverSnapshot = (name: string, generation: number): McpHostServerSnapshot => ({
  configuredProtocol: 'auto',
  configuredServerId: parseConfiguredMcpServerId(name),
  generation,
  state: 'connecting',
  transport: 'stdio',
});

/** Process-level MCP host double: one live server generation plus watch delivery. */
function fakeHost(servers: readonly McpHostServerSnapshot[] = [serverSnapshot('linear', 1)]) {
  let current = servers;
  let revision = 1;
  const listeners = new Set<(event: McpHostWatchEvent) => void>();
  const invoke = vi.fn(async (operation: McpHostOperation): Promise<McpHostOperationResult> => {
    if (operation.type !== 'tools/call') {
      throw new Error(`unexpected operation ${operation.type}`);
    }
    return {
      result: { content: [{ text: `host:${operation.toolName}`, type: 'text' }] },
      type: 'tools/call',
    };
  });
  const port: McpAppsExecutionHostPort = {
    invoke,
    snapshot: () => ({ revision, servers: current }),
    watch: (_filter, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const publish = (next: readonly McpHostServerSnapshot[]): void => {
    current = next;
    revision += 1;
    for (const listener of listeners) {
      listener({ revision, servers: current });
    }
  };
  return {
    invoke,
    port,
    publish,
    setServers: (next: readonly McpHostServerSnapshot[]): void => {
      current = next;
      revision += 1;
    },
    watchCount: () => listeners.size,
  };
}

function createHost(host = fakeHost()) {
  const taskHost = {
    track: vi.fn(
      async (request: McpTaskTrackingRequest): Promise<McpTaskPresentation> => ({
        canCancel: true,
        createdAt: request.result.createdAt,
        handle: {
          authorityEpoch: '00000000-0000-7000-8000-000000000000',
          principalId: 'none',
          resource: 'https://linear.example.test/mcp',
          serverId: request.configuredServerId,
          taskId: request.result.taskId,
        },
        history: [{ at: request.result.createdAt, status: 'working' }],
        omittedHistoryEntries: 0,
        recovery: 'live',
        status: 'working',
        statusMessage: null,
        updatedAt: request.result.lastUpdatedAt,
      })
    ),
  };
  return {
    appHost: new McpDesktopAppHost({
      resolveHost: () => host.port,
      resolveTaskHost: () => taskHost,
    }),
    host,
    taskHost,
  };
}

describe('McpDesktopAppHost', () => {
  it('prepares and executes one live-run ordinary call', async () => {
    const { appHost, host } = createHost();
    const sender = new FakeWebContents(41);
    const ordinary = admission();
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);

    await expect(appHost.prepare(sender, request('prep-1'))).resolves.toEqual({
      decision: 'allow',
      riskCategory: 'mcp',
    });
    await expect(appHost.execute(sender, { preparationId: 'prep-1' })).resolves.toEqual({
      result: { content: [{ text: 'ok', type: 'text' }] },
    });
    expect(ordinary.execute).toHaveBeenCalledTimes(1);
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('reserves a preparation id synchronously so a concurrent duplicate rejects and the first still executes', async () => {
    const { appHost, host } = createHost();
    const sender = new FakeWebContents(43);
    const ordinary = admission('first');
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);

    const [first, second] = await Promise.allSettled([
      appHost.prepare(sender, request('prep-dup')),
      appHost.prepare(sender, request('prep-dup')),
    ]);
    expect(first).toEqual({
      status: 'fulfilled',
      value: { decision: 'allow', riskCategory: 'mcp' },
    });
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toMatchObject({
      code: 'mcp_app_preparation_duplicate',
    });
    await expect(appHost.execute(sender, { preparationId: 'prep-dup' })).resolves.toEqual({
      result: { content: [{ text: 'first', type: 'text' }] },
    });
    expect(ordinary.execute).toHaveBeenCalledTimes(1);
    // Executed preparations are released: a replay fails typed, and the id is free again.
    await expect(appHost.execute(sender, { preparationId: 'prep-dup' })).rejects.toMatchObject({
      code: 'mcp_app_preparation_unavailable',
    });
    await expect(appHost.prepare(sender, request('prep-dup'))).resolves.toEqual({
      decision: 'allow',
      riskCategory: 'mcp',
    });
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('frees a reserved preparation id when preparation itself rejects', async () => {
    const { appHost } = createHost();
    const sender = new FakeWebContents(44);
    await expect(appHost.prepare(sender, request('prep-x'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    });
    const ordinary = admission();
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);
    await expect(appHost.prepare(sender, request('prep-x'))).resolves.toEqual({
      decision: 'allow',
      riskCategory: 'mcp',
    });
  });

  it('rejects execute without prepare, replay, and execute after release', async () => {
    const { appHost } = createHost();
    const sender = new FakeWebContents(42);
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, admission().capability);

    await expect(appHost.execute(sender, { preparationId: 'missing' })).rejects.toThrow(
      /not available/u
    );
    await appHost.prepare(sender, request('once'));
    await appHost.execute(sender, { preparationId: 'once' });
    await expect(appHost.execute(sender, { preparationId: 'once' })).rejects.toThrow(
      /not available/u
    );
    await appHost.prepare(sender, request('released'));
    await appHost.release(sender, { preparationId: 'released' });
    await expect(appHost.execute(sender, { preparationId: 'released' })).rejects.toThrow(
      /not available/u
    );
  });

  it('fails closed with the typed no-admission error', async () => {
    const { appHost } = createHost();
    await expect(appHost.prepare(new FakeWebContents(43), request('prep'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    } satisfies Partial<McpDesktopAppHostError>);
  });

  it('resolves each thread to its own run when two threads share a server', async () => {
    const { appHost } = createHost();
    const sender = new FakeWebContents(46);
    const runA = admission('from-a');
    const runB = admission('from-b');
    appHost.registerAdmission({ runId: 'run-a', threadId: THREAD_A }, runA.capability);
    // Thread B's run registers LATER: recency must not win.
    appHost.registerAdmission({ runId: 'run-b', threadId: THREAD_B }, runB.capability);

    await appHost.prepare(sender, request('prep-a', THREAD_A));
    await appHost.prepare(sender, request('prep-b', THREAD_B));
    await expect(appHost.execute(sender, { preparationId: 'prep-a' })).resolves.toEqual({
      result: { content: [{ text: 'from-a', type: 'text' }] },
    });
    await expect(appHost.execute(sender, { preparationId: 'prep-b' })).resolves.toEqual({
      result: { content: [{ text: 'from-b', type: 'text' }] },
    });
    expect(runA.execute).toHaveBeenCalledTimes(1);
    expect(runB.execute).toHaveBeenCalledTimes(1);
  });

  it('fails typed for a thread with no admission even when another thread admits the server', async () => {
    const { appHost } = createHost();
    appHost.registerAdmission({ runId: 'run-b', threadId: THREAD_B }, admission().capability);

    await expect(
      appHost.prepare(new FakeWebContents(47), request('prep', THREAD_A))
    ).rejects.toMatchObject({ code: 'mcp_app_admission_unavailable' });
  });

  it('fails typed when the owning thread run does not admit the requested server', async () => {
    const { appHost } = createHost();
    const capability: McpAppToolAdmissionCapability = {
      ...admission().capability,
      serverIds: ['other'],
    };
    appHost.registerAdmission({ runId: 'run-a', threadId: THREAD_A }, capability);

    await expect(appHost.prepare(new FakeWebContents(48), request('prep'))).rejects.toMatchObject({
      code: 'mcp_app_admission_unavailable',
    });
  });

  describe('detached admissions (owning run disposed)', () => {
    it('releases pending preparations on dispose, then executes new calls over the host port', async () => {
      const { appHost, host } = createHost();
      const sender = new FakeWebContents(49);
      const run = { runId: 'run-a', threadId: THREAD_A };
      const live = admission();
      appHost.registerAdmission(run, live.capability);
      await appHost.prepare(sender, request('pending'));

      appHost.invalidateAdmission(run);

      await expect(appHost.execute(sender, { preparationId: 'pending' })).rejects.toThrow(
        /not available/u
      );
      await expect(appHost.prepare(sender, request('after'))).resolves.toEqual({
        decision: 'allow',
        riskCategory: 'mcp',
      });
      await expect(appHost.execute(sender, { preparationId: 'after' })).resolves.toEqual({
        result: { content: [{ text: 'host:create_issue', type: 'text' }] },
      });
      expect(live.execute).not.toHaveBeenCalled();
      expect(host.invoke).toHaveBeenCalledTimes(1);
      expect(host.invoke).toHaveBeenCalledWith(
        {
          arguments: { title: 'Issue' },
          configuredServerId: 'linear',
          toolName: 'create_issue',
          type: 'tools/call',
        },
        { signal: expect.any(AbortSignal) }
      );
    });

    it('keeps the static ask decision and risk category for detached calls', async () => {
      const { appHost, host } = createHost();
      const sender = new FakeWebContents(50);
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission('unused', undefined, 'ask', 'execute').capability);
      appHost.invalidateAdmission(run);

      await expect(appHost.prepare(sender, request('ask'))).resolves.toEqual({
        decision: 'ask',
        riskCategory: 'execute',
      });
      expect(host.invoke).not.toHaveBeenCalled();
    });

    it('rejects a detached call for a tool the admission never admitted', async () => {
      const { appHost, host } = createHost();
      const run = { runId: 'run-a', threadId: THREAD_A };
      const capability: McpAppToolAdmissionCapability = {
        admit: vi.fn(() => {
          throw new Error('MCP Apps tool linear.create_issue is not admitted');
        }),
        appCapableToolCount: 1,
        inadmissibleTools: [],
        serverIds: ['linear'],
      };
      appHost.registerAdmission(run, capability);
      appHost.invalidateAdmission(run);

      await expect(appHost.prepare(new FakeWebContents(51), request('nope'))).rejects.toThrow(
        /not admitted/u
      );
      expect(host.invoke).not.toHaveBeenCalled();
    });

    it('executes a detached preparation once and honours release', async () => {
      const { appHost, host } = createHost();
      const sender = new FakeWebContents(52);
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);

      await appHost.prepare(sender, request('once'));
      await appHost.execute(sender, { preparationId: 'once' });
      await expect(appHost.execute(sender, { preparationId: 'once' })).rejects.toThrow(
        /not available/u
      );
      await appHost.prepare(sender, request('released'));
      await appHost.release(sender, { preparationId: 'released' });
      await expect(appHost.execute(sender, { preparationId: 'released' })).rejects.toThrow(
        /not available/u
      );
      expect(host.invoke).toHaveBeenCalledTimes(1);
    });

    it('is superseded by a newer run of the same thread', async () => {
      const { appHost, host } = createHost();
      const sender = new FakeWebContents(53);
      const older = { runId: 'run-1', threadId: THREAD_A };
      appHost.registerAdmission(older, admission('older').capability);
      appHost.invalidateAdmission(older);
      await appHost.prepare(sender, request('stale'));
      expect(host.watchCount()).toBe(1);

      const newer = admission('newer');
      appHost.registerAdmission({ runId: 'run-2', threadId: THREAD_A }, newer.capability);

      expect(host.watchCount()).toBe(0);
      await expect(appHost.execute(sender, { preparationId: 'stale' })).rejects.toThrow(
        /not available/u
      );
      await appHost.prepare(sender, request('fresh'));
      await expect(appHost.execute(sender, { preparationId: 'fresh' })).resolves.toEqual({
        result: { content: [{ text: 'newer', type: 'text' }] },
      });
      expect(host.invoke).not.toHaveBeenCalled();

      // Disposing the OLDER run again must not touch the newer admission.
      appHost.invalidateAdmission(older);
      await expect(appHost.prepare(sender, request('still-live'))).resolves.toMatchObject({
        decision: 'allow',
      });
      expect(newer.execute).toHaveBeenCalledTimes(1);
    });

    it('drops the detached admission when the server generation retires', async () => {
      const { appHost, host } = createHost();
      const sender = new FakeWebContents(54);
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);
      await appHost.prepare(sender, request('pending'));

      host.publish([serverSnapshot('linear', 2)]);

      expect(host.watchCount()).toBe(0);
      await expect(appHost.execute(sender, { preparationId: 'pending' })).rejects.toThrow(
        /not available/u
      );
      await expect(appHost.prepare(sender, request('after'))).rejects.toMatchObject({
        code: 'mcp_app_admission_unavailable',
      });
      expect(host.invoke).not.toHaveBeenCalled();
    });

    it('drops the detached admission when the server is removed from the host', async () => {
      const { appHost, host } = createHost();
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);

      host.publish([]);

      expect(host.watchCount()).toBe(0);
      await expect(
        appHost.prepare(new FakeWebContents(55), request('after'))
      ).rejects.toMatchObject({ code: 'mcp_app_admission_unavailable' });
    });

    it('re-checks the live generation at prepare time even before the watch delivers', async () => {
      const { appHost, host } = createHost();
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);

      // The snapshot moves ahead without a watch delivery yet (microtask-queued).
      host.setServers([serverSnapshot('linear', 2)]);

      await expect(appHost.prepare(new FakeWebContents(56), request('gen'))).rejects.toMatchObject({
        code: 'mcp_app_admission_unavailable',
      });
      expect(host.watchCount()).toBe(0);
    });

    it('never detaches an admission whose server is not live on the host', async () => {
      const host = fakeHost([]);
      const { appHost } = createHost(host);
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);

      expect(host.watchCount()).toBe(0);
      await expect(
        appHost.prepare(new FakeWebContents(58), request('after'))
      ).rejects.toMatchObject({ code: 'mcp_app_admission_unavailable' });
    });

    it('hands a created task from a detached call to the task host and returns the canonical CreateTaskResult', async () => {
      const { appHost, host, taskHost } = createHost();
      const created = {
        createdAt: '2026-09-01T05:00:00.000Z',
        lastUpdatedAt: '2026-09-01T05:00:00.000Z',
        resultType: 'task' as const,
        status: 'working' as const,
        taskId: 'task-detached',
        ttlMs: null,
      };
      // The host port parses tools/call answers with the SDK CallToolResult
      // schema, which defaults `content: []` onto a bare CreateTaskResult.
      host.invoke.mockResolvedValueOnce({
        result: { ...created, content: [] },
        type: 'tools/call',
      });
      const sender = new FakeWebContents(52);
      const ordinary = admission();
      appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);
      appHost.invalidateAdmission({ runId: 'run-1', threadId: THREAD_A });

      await appHost.prepare(sender, request('prep-task'));
      await expect(appHost.execute(sender, { preparationId: 'prep-task' })).resolves.toEqual({
        result: { ...created, content: [] },
      });
      expect(taskHost.track).toHaveBeenCalledTimes(1);
      expect(taskHost.track).toHaveBeenCalledWith(
        {
          configuredServerId: 'linear',
          result: { ...created, content: [] },
          toolName: 'create_issue',
        },
        expect.any(AbortSignal)
      );
    });

    it('fails a detached call visibly when the created task cannot be tracked', async () => {
      const { appHost, host, taskHost } = createHost();
      host.invoke.mockResolvedValueOnce({
        result: {
          content: [],
          createdAt: '2026-09-01T05:00:00.000Z',
          lastUpdatedAt: '2026-09-01T05:00:00.000Z',
          resultType: 'task',
          status: 'working',
          taskId: 'task-untracked',
          ttlMs: null,
        },
        type: 'tools/call',
      });
      taskHost.track.mockRejectedValueOnce(new Error('no live MCP Tasks session'));
      const sender = new FakeWebContents(53);
      const ordinary = admission();
      appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, ordinary.capability);
      appHost.invalidateAdmission({ runId: 'run-1', threadId: THREAD_A });

      await appHost.prepare(sender, request('prep-task-2'));
      await expect(appHost.execute(sender, { preparationId: 'prep-task-2' })).rejects.toThrow(
        'no live MCP Tasks session'
      );
    });

    it('surfaces a host port that answers with the wrong operation type', async () => {
      const host = fakeHost();
      host.invoke.mockResolvedValueOnce({
        result: { tools: [] },
        type: 'tools/list',
      });
      const { appHost } = createHost(host);
      const sender = new FakeWebContents(59);
      const run = { runId: 'run-a', threadId: THREAD_A };
      appHost.registerAdmission(run, admission().capability);
      appHost.invalidateAdmission(run);

      await appHost.prepare(sender, request('bad'));
      await expect(appHost.execute(sender, { preparationId: 'bad' })).rejects.toThrow(
        /tools\/call/u
      );
    });
  });

  it('lets a newer run of the same thread supersede the older live admission', async () => {
    const { appHost } = createHost();
    const sender = new FakeWebContents(60);
    const older = admission('older');
    const newer = admission('newer');
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, older.capability);
    await appHost.prepare(sender, request('stale'));

    appHost.registerAdmission({ runId: 'run-2', threadId: THREAD_A }, newer.capability);

    // The superseded run's pending preparation is released, never executed.
    await expect(appHost.execute(sender, { preparationId: 'stale' })).rejects.toThrow(
      /not available/u
    );
    await appHost.prepare(sender, request('fresh'));
    await expect(appHost.execute(sender, { preparationId: 'fresh' })).resolves.toEqual({
      result: { content: [{ text: 'newer', type: 'text' }] },
    });
    expect(older.execute).not.toHaveBeenCalled();

    // Disposing the OLDER run later must not tear down the newer admission.
    appHost.invalidateAdmission({ runId: 'run-1', threadId: THREAD_A });
    await expect(appHost.prepare(sender, request('still-live'))).resolves.toMatchObject({
      decision: 'allow',
    });
  });

  it('rejects registering the same run twice', () => {
    const { appHost } = createHost();
    const run = { runId: 'run-1', threadId: THREAD_A };
    appHost.registerAdmission(run, admission().capability);
    expect(() => appHost.registerAdmission(run, admission().capability)).toThrow(
      /already registered/u
    );
  });

  it('force-releases a sender entries when its WebContents is destroyed', async () => {
    const { appHost } = createHost();
    const sender = new FakeWebContents(44);
    appHost.registerAdmission({ runId: 'run-1', threadId: THREAD_A }, admission().capability);
    await appHost.prepare(sender, request('destroyed'));

    sender.destroy();

    await expect(appHost.execute(sender, { preparationId: 'destroyed' })).rejects.toThrow(
      /not available/u
    );
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
});
