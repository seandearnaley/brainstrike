import { describe, expect, test, vi } from 'vitest';
import { joinHostThreadSettlements, settleHostRunResources } from '../src/core-run-lifecycle.js';
import { createHostRunState, type HostRunState } from '../src/core-state.js';
import { assertHostRunStartAvailable } from '../src/run-branch.js';

const run = (threadId: string, runId: string): HostRunState => ({
  ...createHostRunState(
    threadId,
    runId,
    'openai::gpt-6-sol',
    { author: 'person', parentMessageId: null, prompt: runId, userMessageId: `user-${runId}` },
    { categories: new Set(), outsideSandbox: new Set(), tools: new Set() }
  ),
  terminal: true,
});

describe("a finished run's settlement", () => {
  test('releases the run only once its resources joined, then clears', async () => {
    const finished = run('a', 'a1');
    const release = vi.fn();
    finished.release = release;
    const close = Promise.withResolvers<void>();
    const settlement = settleHostRunResources(finished, () => close.promise);
    // A CLI host stays retained while its run is still settling.
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    expect(finished.settlement).toBe(settlement);
    expect(() => assertHostRunStartAvailable([finished], 'a')).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ code: 'run.settling' }) })
    );
    close.resolve();
    await joinHostThreadSettlements([finished], 'a');
    expect(release).toHaveBeenCalledOnce();
    expect(finished.release).toBeUndefined();
    expect(finished.settlement).toBeUndefined();
    expect(() => assertHostRunStartAvailable([finished], 'a')).not.toThrow();
  });

  test('a resource that never joined keeps the thread refused with its cleanup failure', async () => {
    const finished = run('a', 'a1');
    const release = vi.fn();
    finished.release = release;
    const unjoined = new Error('The admission still owns its MCP lease');
    await expect(settleHostRunResources(finished, () => Promise.reject(unjoined))).rejects.toBe(
      unjoined
    );
    expect(release).not.toHaveBeenCalled();
    await expect(joinHostThreadSettlements([finished], 'a')).rejects.toBe(unjoined);
    expect(() => assertHostRunStartAvailable([finished], 'a')).toThrow(
      expect.objectContaining({ failure: expect.objectContaining({ code: 'run.settling' }) })
    );
  });

  test("another thread's settlement never holds an admission", async () => {
    const settling = run('b', 'b1');
    const otherSettlement = settleHostRunResources(
      settling,
      () => new Promise<void>(() => undefined)
    );
    expect(otherSettlement).toBe(settling.settlement);
    await expect(joinHostThreadSettlements([settling], 'a')).resolves.toBeUndefined();
    expect(() => assertHostRunStartAvailable([settling], 'a')).not.toThrow();
  });
});
