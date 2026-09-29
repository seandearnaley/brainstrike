import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan } from '../src/fault-plan-claim';
import {
  applyMcpLabHttpFault,
  createMcpLabFaultRuntime,
  McpLabDroppedResponseError,
} from '../src/fault-runtime';
import { createMcpLabFaultPlan } from '../src/faults';

describe('MCP lab fault runtime', () => {
  it('accounts for occurrences per accepted coordinate and preserves correlation', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 418 },
        id: 'second-tools-list',
        match: { method: 'tools/list', occurrence: 2, phase: 'operation' },
      },
      {
        fault: { kind: 'malformed_json', payload: '{"broken":' },
        id: 'first-tools-call',
        match: { method: 'tools/call', occurrence: 1, phase: 'operation' },
      },
    ]);
    const runtime = createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference');

    expect(runtime.consume('operation', 'tools/list', 'correlation-list-1')).toBeUndefined();
    expect(runtime.consume('operation', 'tools/call', 'correlation-call-1')).toMatchObject({
      id: 'first-tools-call',
    });
    expect(runtime.consume('operation', 'tools/list', 'correlation-list-2')).toMatchObject({
      id: 'second-tools-list',
    });
    expect(plan.observations()).toEqual([
      expect.objectContaining({
        correlationId: 'correlation-call-1',
        faultId: 'first-tools-call',
        occurrence: 1,
      }),
      expect.objectContaining({
        correlationId: 'correlation-list-2',
        faultId: 'second-tools-list',
        occurrence: 2,
      }),
    ]);
    expect(runtime.untriggeredIds()).toEqual([]);
  });

  it('reserves unique deterministic correlations and detects remaining HTTP coordinates', () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { kind: 'http_status', status: 503 },
        id: 'pending-tools-list',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const runtime = createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference');

    expect(runtime.reserveCorrelation()).toBe('modern-reference:exchange:1');
    expect(runtime.reserveCorrelation(undefined, 'dispatch')).toBe('modern-reference:dispatch:2');
    expect(runtime.reserveCorrelation('caller.safe:1')).toBe('caller.safe:1');
    expect(() => runtime.reserveCorrelation('caller.safe:1')).toThrow(/duplicate.*correlation/i);
    expect(() => runtime.reserveCorrelation('unsafe correlation')).toThrow(/invalid.*correlation/i);
    expect(runtime.requiresHttpQualification()).toBe(true);
    expect(runtime.requiresProtocolBodyCoordinate()).toBe(true);
    runtime.consume('operation', 'tools/list', 'correlation-tools');
    expect(runtime.requiresHttpQualification()).toBe(false);
    expect(runtime.requiresProtocolBodyCoordinate()).toBe(false);
  });

  it('records active delay execution and request-driven abort without a wall clock', async () => {
    const plan = createMcpLabFaultPlan([
      {
        fault: { delayMs: 60_000, kind: 'delay' },
        id: 'abortable-delay',
        match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
      },
    ]);
    const runtime = createMcpLabFaultRuntime(claimMcpLabFaultPlan(plan), 'modern-reference');
    const applied = runtime.consume('operation', 'tools/list', 'correlation-tools');
    if (!applied) {
      throw new Error('Expected configured delay fault');
    }
    expect(plan.executionState(applied.id)).toBe('observed');
    const controller = new AbortController();
    const execution = runtime.applyHttpFault(applied, controller.signal);
    expect(plan.executionState(applied.id)).toBe('active');
    controller.abort();
    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(plan.executionState(applied.id)).toBe('aborted');
  });

  it('applies every HTTP-compatible fault without degrading unsupported kinds', async () => {
    vi.useFakeTimers();
    try {
      const delayed = applyMcpLabHttpFault({
        fault: { delayMs: 25, kind: 'delay' },
        id: 'delay-response',
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(delayed).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    await expect(
      applyMcpLabHttpFault({ fault: { kind: 'http_status', status: 429 }, id: 'rate-limit' })
    ).resolves.toMatchObject({ status: 429 });
    const malformed = await applyMcpLabHttpFault({
      fault: { kind: 'malformed_json', payload: '{"broken":' },
      id: 'malformed-response',
    });
    expect(await malformed?.text()).toBe('{"broken":');
    expect(malformed?.headers.get('content-type')).toContain('application/json');
    await expect(
      applyMcpLabHttpFault({ fault: { kind: 'drop_response' }, id: 'drop-response' })
    ).rejects.toBeInstanceOf(McpLabDroppedResponseError);
    await expect(
      applyMcpLabHttpFault({ fault: { kind: 'cleanup_error' }, id: 'wrong-scope' })
    ).rejects.toThrow(/cannot target an HTTP exchange/);

    for (const applied of [
      { fault: { kind: 'http_status' as const, status: 503 }, id: 'replace-status' },
      {
        fault: { kind: 'malformed_json' as const, payload: '{"broken":' },
        id: 'replace-malformed',
      },
    ]) {
      const cancel = vi.fn();
      const displaced = new Response(new ReadableStream({ cancel }));
      await expect(applyMcpLabHttpFault(applied, displaced)).resolves.toBeDefined();
      expect(cancel).toHaveBeenCalledOnce();
    }
    const cancelDrop = vi.fn();
    await expect(
      applyMcpLabHttpFault(
        { fault: { kind: 'drop_response' }, id: 'replace-drop' },
        new Response(new ReadableStream({ cancel: cancelDrop }))
      )
    ).rejects.toBeInstanceOf(McpLabDroppedResponseError);
    expect(cancelDrop).toHaveBeenCalledOnce();
    const cancelDelay = vi.fn();
    await expect(
      applyMcpLabHttpFault(
        { fault: { delayMs: 0, kind: 'delay' }, id: 'delay' },
        new Response(new ReadableStream({ cancel: cancelDelay }))
      )
    ).resolves.toBeUndefined();
    expect(cancelDelay).not.toHaveBeenCalled();
  });
});
