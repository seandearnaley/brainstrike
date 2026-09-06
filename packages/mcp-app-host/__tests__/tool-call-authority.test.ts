import { describe, expect, it, vi } from 'vitest';
import {
  type McpAppPreparedToolCall,
  McpAppProvenanceAuthority,
  McpAppToolCallAuthority,
} from '../src/index.js';

function setup() {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'linear' });
  provenance.registerTool(generation, {
    _meta: { ui: { visibility: ['app'] } },
    name: 'create_issue',
  });
  return { generation, provenance };
}

function prepared(
  decision: McpAppPreparedToolCall['decision'],
  execute: McpAppPreparedToolCall['execute'] = vi.fn(async () => ({
    content: [{ text: 'done', type: 'text' }],
  }))
): McpAppPreparedToolCall {
  return Object.freeze({
    decision,
    execute,
    riskCategory: 'execute',
  });
}

async function releasePreparation(): Promise<void> {
  await Promise.resolve();
}

describe('MCP Apps ordinary tool-call authority', () => {
  it('executes an allowed app-visible call through the injected ordinary authority', async () => {
    const { generation, provenance } = setup();
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      return { content: [{ text: 'created', type: 'text' }] };
    });
    const prepare = vi.fn(async () => prepared('allow', execute));
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare,
      provenance,
      release: releasePreparation,
    });

    await expect(
      authority.call({ arguments: { title: 'Grounded' }, id: 'call-1', name: 'create_issue' })
    ).resolves.toEqual({ content: [{ text: 'created', type: 'text' }] });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'app',
        id: 'call-1',
        input: { title: 'Grounded' },
        serverId: 'linear',
        toolName: 'create_issue',
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^mcp-app-preparation-[0-9a-f-]{36}-1-1$/),
        signal: expect.any(AbortSignal),
      })
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authority.snapshot).toEqual({
      listenerCount: 0,
      pendingApprovals: [],
      pendingCalls: 0,
      phase: 'open',
    });
  });

  it('issues preparation ids that never collide across authorities of the same generation', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { generation, provenance } = setup();
      const authority = new McpAppToolCallAuthority({
        generation,
        prepare: vi.fn(async (_call, context) => {
          ids.push(context.id);
          return prepared('allow');
        }),
        provenance,
        release: releasePreparation,
      });
      await authority.call({ arguments: {}, id: `call-${index}`, name: 'create_issue' });
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(256);
    }
  });

  it('never executes ask or deny decisions without explicit host consent', async () => {
    const { generation, provenance } = setup();
    const askExecute = vi.fn(async () => ({ content: [] }));
    const decisions: McpAppPreparedToolCall[] = [prepared('ask', askExecute), prepared('deny')];
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare: async () => {
        const next = decisions.shift();
        if (!next) {
          throw new Error('missing decision');
        }
        return next;
      },
      provenance,
      release: releasePreparation,
    });

    const pending = authority.call({ arguments: {}, id: 'ask-1', name: 'create_issue' });
    await vi.waitFor(() => expect(authority.snapshot.pendingApprovals).toHaveLength(1));
    expect(askExecute).not.toHaveBeenCalled();

    const approval = authority.snapshot.pendingApprovals[0];
    expect(approval).toMatchObject({ riskCategory: 'execute', toolName: 'create_issue' });
    if (!approval) {
      throw new Error('expected approval');
    }
    expect(authority.approve(approval.id)).toBe(true);
    await expect(pending).resolves.toEqual({ content: [] });
    expect(askExecute).toHaveBeenCalledTimes(1);

    await expect(
      authority.call({ arguments: {}, id: 'deny-1', name: 'create_issue' })
    ).rejects.toMatchObject({ code: -32_001, message: 'MCP Apps tool call denied by policy' });
    expect(authority.snapshot.pendingCalls).toBe(0);
  });

  it('denies consent explicitly and releases the provenance call id for retry', async () => {
    const { generation, provenance } = setup();
    const execute = vi.fn(async () => ({ content: [] }));
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare: async () => prepared('ask', execute),
      provenance,
      release: releasePreparation,
    });

    const first = authority.call({ arguments: {}, id: 7, name: 'create_issue' });
    await vi.waitFor(() => expect(authority.snapshot.pendingApprovals).toHaveLength(1));
    const approval = authority.snapshot.pendingApprovals[0];
    if (!approval) {
      throw new Error('expected approval');
    }
    expect(authority.deny(approval.id)).toBe(true);
    await expect(first).rejects.toMatchObject({
      code: -32_001,
      message: 'MCP Apps tool call declined by user',
    });
    expect(execute).not.toHaveBeenCalled();

    const retry = authority.call({ arguments: {}, id: 7, name: 'create_issue' });
    await vi.waitFor(() => expect(authority.snapshot.pendingApprovals).toHaveLength(1));
    authority.deny(authority.snapshot.pendingApprovals[0]?.id ?? 'missing');
    await expect(retry).rejects.toMatchObject({ code: -32_001 });
  });

  it('releases each denied or cancelled preparation before the authority call settles', async () => {
    const { generation, provenance } = setup();
    const release = vi.fn(async () => undefined);
    let resolvePrepare: ((value: McpAppPreparedToolCall) => void) | undefined;
    const prepare = vi
      .fn<() => Promise<McpAppPreparedToolCall>>()
      .mockResolvedValueOnce(prepared('deny'))
      .mockResolvedValueOnce(prepared('deny'))
      .mockImplementationOnce(
        async () =>
          await new Promise<McpAppPreparedToolCall>((resolve) => {
            resolvePrepare = resolve;
          })
      );
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare,
      provenance,
      release,
    });

    await expect(
      authority.call({ arguments: {}, id: 'deny-1', name: 'create_issue' })
    ).rejects.toMatchObject({ code: -32_001 });
    await expect(
      authority.call({ arguments: {}, id: 'deny-2', name: 'create_issue' })
    ).rejects.toMatchObject({ code: -32_001 });
    expect(release).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    const cancelled = authority.call(
      { arguments: {}, id: 'cancelled-prepare', name: 'create_issue' },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(resolvePrepare).toBeTypeOf('function'));
    controller.abort(new Error('cancel prepare response'));
    await expect(cancelled).rejects.toThrow('cancel prepare response');
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('forwards caller cancellation and becomes quiescent after close or failure', async () => {
    const { generation, provenance } = setup();
    const observed: AbortSignal[] = [];
    const authority = new McpAppToolCallAuthority({
      generation,
      onDiagnostic: vi.fn(),
      prepare: async () =>
        prepared('allow', async ({ signal }) => {
          observed.push(signal);
          return await new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }),
      provenance,
      release: releasePreparation,
    });
    const controller = new AbortController();
    const call = authority.call(
      { arguments: {}, id: 'cancel-me', name: 'create_issue' },
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    controller.abort(new Error('tab closed'));
    await expect(call).rejects.toThrow('tab closed');
    expect(authority.snapshot.pendingCalls).toBe(0);

    const pending = authority.call({ arguments: {}, id: 'close-me', name: 'create_issue' });
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    const close = authority.close();
    await expect(pending).rejects.toThrow('MCP Apps tool-call authority closed');
    await expect(close).resolves.toMatchObject({ pendingCalls: 0, phase: 'closed' });
    expect(observed[1]?.aborted).toBe(true);
    expect(authority.snapshot).toEqual({
      listenerCount: 0,
      pendingApprovals: [],
      pendingCalls: 0,
      phase: 'closed',
    });
  });

  it('stays quiescent when the generation is torn down mid-call', async () => {
    const { generation, provenance } = setup();
    const onDiagnostic = vi.fn();
    const gate = Promise.withResolvers<McpAppPreparedToolCall>();
    const authority = new McpAppToolCallAuthority({
      generation,
      onDiagnostic,
      prepare: vi.fn(async () => await gate.promise),
      provenance,
      release: releasePreparation,
    });
    const call = authority.call({ arguments: {}, id: 'call-torn', name: 'create_issue' });
    await Promise.resolve();
    // The app's server generation goes away while the call is in flight.
    provenance.retireGeneration(generation);
    gate.reject(new Error('preparation failed after teardown'));

    // The original failure surfaces (a cancel error never replaces it), and
    // cleanup still ran: nothing pending, close() resolves.
    await expect(call).rejects.toThrow(/preparation failed after teardown/u);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'preparation failed after teardown' })
    );
    expect(authority.snapshot).toMatchObject({ pendingCalls: 0 });
    await expect(authority.close()).resolves.toMatchObject({ pendingCalls: 0, phase: 'closed' });
  });

  it('refuses unowned and model-only tools before policy preparation', async () => {
    const { generation, provenance } = setup();
    provenance.registerTool(generation, {
      _meta: { ui: { visibility: ['model'] } },
      name: 'internal_only',
    });
    const prepare = vi.fn(async () => prepared('allow'));
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare,
      provenance,
      release: releasePreparation,
    });

    await expect(
      authority.call({ arguments: {}, id: 'unknown', name: 'missing' })
    ).rejects.toMatchObject({ code: -32_601, message: 'MCP Apps tool is not available' });
    await expect(
      authority.call({ arguments: {}, id: 'hidden', name: 'internal_only' })
    ).rejects.toMatchObject({ code: -32_601, message: 'MCP Apps tool is not available' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('publishes referentially stable external-store snapshots and releases listeners on close', async () => {
    const { generation, provenance } = setup();
    const authority = new McpAppToolCallAuthority({
      generation,
      prepare: async () => prepared('allow'),
      provenance,
      release: releasePreparation,
    });
    const listener = vi.fn();

    expect(authority.snapshot).toBe(authority.snapshot);
    const unsubscribe = authority.subscribe(listener);
    const subscribed = authority.snapshot;
    expect(subscribed.listenerCount).toBe(1);
    expect(authority.snapshot).toBe(subscribed);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(authority.snapshot.listenerCount).toBe(0);
    await authority.close();
    expect(authority.snapshot).toMatchObject({ listenerCount: 0, phase: 'closed' });
    expect(authority.subscribe(listener)).toBeTypeOf('function');
  });
});
