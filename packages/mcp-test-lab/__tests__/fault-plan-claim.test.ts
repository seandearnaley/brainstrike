import { describe, expect, it, vi } from 'vitest';
import { claimMcpLabFaultPlan, startWithClaimedMcpLabFaultPlan } from '../src/fault-plan-claim';
import { createMcpLabFaultPlan } from '../src/faults';
import { startMcpLabScenario } from '../src/lab';

function createPlan() {
  return createMcpLabFaultPlan([
    {
      fault: { kind: 'http_status', status: 418 },
      id: 'claimed-tools-list',
      match: { method: 'tools/list', occurrence: 1, phase: 'operation' },
    },
  ]);
}

describe('MCP fault plan claims', () => {
  it('claims exactly once and blocks every public mutation after ownership transfers', () => {
    const plan = createPlan();
    const claimed = claimMcpLabFaultPlan(plan);
    if (!claimed) {
      throw new Error('Expected a claimed fault plan');
    }

    expect(() => claimMcpLabFaultPlan(plan)).toThrow(/already claimed by a session/i);
    expect(() =>
      plan.consume({
        correlationId: 'public-after-claim',
        method: 'tools/list',
        occurrence: 1,
        phase: 'operation',
      })
    ).toThrow(/claimed by a session/i);
    expect(() =>
      plan.consumeIfConfigured({
        correlationId: 'public-optional-after-claim',
        method: 'tools/list',
        occurrence: 2,
        phase: 'operation',
      })
    ).toThrow(/claimed by a session/i);

    expect(
      claimed.consume({
        correlationId: 'claimed-runtime',
        method: 'tools/list',
        occurrence: 1,
        phase: 'operation',
      })
    ).toEqual({ kind: 'http_status', status: 418 });
    expect(plan.observations()).toEqual([
      expect.objectContaining({ correlationId: 'claimed-runtime', faultId: 'claimed-tools-list' }),
    ]);
  });

  it('rejects a plan whose public API consumed a fault before session startup', () => {
    const plan = createPlan();
    plan.consume({
      correlationId: 'premature-consumption',
      method: 'tools/list',
      occurrence: 1,
      phase: 'operation',
    });

    expect(() => claimMcpLabFaultPlan(plan)).toThrow(/consumed before session startup/i);
  });

  it('does not taint a fresh plan when an optional public probe matches nothing', () => {
    const plan = createPlan();
    expect(
      plan.consumeIfConfigured({
        correlationId: 'unmatched-probe',
        method: 'tools/list',
        occurrence: 2,
        phase: 'operation',
      })
    ).toBeUndefined();
    expect(claimMcpLabFaultPlan(plan)).toBeDefined();
  });

  it('rechecks ownership after accessor inputs claim the plan reentrantly', async () => {
    const plan = createPlan();
    let started: ReturnType<typeof startMcpLabScenario> | undefined;

    expect(() =>
      plan.consume({
        get correlationId(): string {
          started = startMcpLabScenario('modern-reference', {
            execution: 'in-process',
            faultPlan: plan,
          });
          return 'reentrant-public-consumption';
        },
        method: 'tools/list',
        occurrence: 1,
        phase: 'operation',
      })
    ).toThrow(/claimed by a session/i);
    if (!started) {
      throw new Error('Expected the accessor to start a claimed session');
    }
    const session = await started;
    try {
      expect(plan.untriggeredIds()).toEqual(['claimed-tools-list']);
    } finally {
      await session.close();
    }
  });

  it('claims before allocation and allows exactly one attachment while allocation is pending', async () => {
    const plan = createPlan();
    let allocationEntered: (() => void) | undefined;
    let releaseAllocation: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      allocationEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAllocation = resolve;
    });
    let allocatorCalls = 0;
    const first = startWithClaimedMcpLabFaultPlan(plan, async () => {
      allocatorCalls += 1;
      allocationEntered?.();
      await released;
      return 'allocated';
    });
    await entered;

    expect(() =>
      startWithClaimedMcpLabFaultPlan(plan, () => {
        allocatorCalls += 1;
        return 'second-allocation';
      })
    ).toThrow(/already claimed by a session/i);
    expect(allocatorCalls).toBe(1);
    releaseAllocation?.();
    await expect(first).resolves.toBe('allocated');
  });

  it('rejects a pre-consumed plan without invoking allocation', () => {
    const plan = createPlan();
    plan.consume({
      correlationId: 'preconsumed-plan',
      method: 'tools/list',
      occurrence: 1,
      phase: 'operation',
    });
    const allocate = vi.fn();

    expect(() => startWithClaimedMcpLabFaultPlan(plan, allocate)).toThrow(
      /consumed before session startup/i
    );
    expect(allocate).not.toHaveBeenCalled();
  });

  it('keeps the claim permanent when allocation fails after ownership transfer', () => {
    const plan = createPlan();
    const startupError = new Error('controlled allocation failure');
    const allocate = vi.fn(() => {
      throw startupError;
    });

    expect(() => startWithClaimedMcpLabFaultPlan(plan, allocate)).toThrow(startupError);
    expect(() => startWithClaimedMcpLabFaultPlan(plan, vi.fn())).toThrow(
      /already claimed by a session/i
    );
    expect(allocate).toHaveBeenCalledTimes(1);
  });
});
