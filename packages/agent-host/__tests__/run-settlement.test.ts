import { describe, expect, test, vi } from 'vitest';
import { joinHostThreadSettlements, settleHostRunOwner } from '../src/core-run-lifecycle.js';
import { createHostRunState, type HostRunState } from '../src/core-state.js';
import { assertHostRunStartAvailable } from '../src/run-admission.js';

const run = (threadId: string, runId: string): HostRunState => ({
  ...createHostRunState(
    threadId,
    runId,
    'openai::gpt-6-sol',
    { parentMessageId: null, prompt: runId, userMessageId: `user-${runId}` },
    { categories: new Set(), tools: new Set() }
  ),
  terminal: true,
});

describe("a finished run's memory settlement", () => {
  test('releases the run only once its owner joined, then clears', async () => {
    const finished = run('a', 'a1');
    const release = vi.fn();
    finished.release = release;
    const close = Promise.withResolvers<void>();
    const settlement = settleHostRunOwner(finished, () => close.promise);
    // A CLI host stays retained while its run's memory is still settling.
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

  test('an owner that never joined keeps the thread refused with its cleanup failure', async () => {
    const finished = run('a', 'a1');
    const release = vi.fn();
    finished.release = release;
    const unjoined = new Error('Observational memory still owns native work');
    await expect(settleHostRunOwner(finished, () => Promise.reject(unjoined))).rejects.toBe(
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
    settleHostRunOwner(settling, () => new Promise<void>(() => undefined));
    await expect(joinHostThreadSettlements([settling], 'a')).resolves.toBeUndefined();
    expect(() => assertHostRunStartAvailable([settling], 'a')).not.toThrow();
  });
});
