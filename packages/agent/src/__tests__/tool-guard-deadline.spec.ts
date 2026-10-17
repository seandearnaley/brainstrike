import { describe, expect, it } from 'vitest';
import {
  readToolGuardDeadlineSignal,
  registerToolGuardDeadlineSignal,
  resolveGuardedToolSignal,
} from '../tools/tool-guard-deadline';

describe('resolveGuardedToolSignal', () => {
  it('isolates duplicate provider IDs in concurrent run and thread contexts', () => {
    const a = { runId: 'run-a', threadId: 'thread-a', toolCallId: 'call_1' };
    const b = { runId: 'run-b', threadId: 'thread-b', toolCallId: 'call_1' };
    const deadlineA = new AbortController();
    const deadlineB = new AbortController();
    const releaseA = registerToolGuardDeadlineSignal([{}, a], deadlineA.signal);
    const releaseB = registerToolGuardDeadlineSignal([{}, b], deadlineB.signal);
    try {
      const signalA = resolveGuardedToolSignal(a);
      const signalB = resolveGuardedToolSignal(b);
      deadlineA.abort(new Error('only A timed out'));
      expect(signalA?.aborted).toBe(true);
      expect(signalB?.aborted).toBe(false);
      releaseB();
      expect(readToolGuardDeadlineSignal(a)).toBe(deadlineA.signal);
    } finally {
      releaseA();
      releaseB();
    }
  });

  it('does not look up a deadline through copied provider identity fields', () => {
    const context = Object.freeze({ toolCallId: 'call-copy' });
    const guard = new AbortController();
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      expect(readToolGuardDeadlineSignal(context)).toBe(guard.signal);
      expect(readToolGuardDeadlineSignal({ ...context })).toBeUndefined();
    } finally {
      release();
    }
  });

  it('keeps release idempotent when a completed context is registered again', () => {
    const context = { toolCallId: 'reused' };
    const releaseA = registerToolGuardDeadlineSignal([{}, context], new AbortController().signal);
    releaseA();
    const next = new AbortController();
    const releaseB = registerToolGuardDeadlineSignal([{}, context], next.signal);
    try {
      releaseA();
      expect(readToolGuardDeadlineSignal(context)).toBe(next.signal);
    } finally {
      releaseB();
      releaseB();
    }
    expect(readToolGuardDeadlineSignal(context)).toBeUndefined();
  });

  it('refuses conflicting manual ownership instead of replacing a live deadline', () => {
    const context = { toolCallId: 'same-context' };
    const guard = new AbortController();
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      expect(() =>
        registerToolGuardDeadlineSignal([{}, context], new AbortController().signal)
      ).toThrow('already owns a guard deadline');
      expect(readToolGuardDeadlineSignal(context)).toBe(guard.signal);
    } finally {
      release();
    }
  });

  it.each(['caller', 'deadline'])('retains an already-aborted %s reason by identity', (owner) => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const reason = { stoppedBy: owner };
    (owner === 'caller' ? caller : deadline).abort(reason);
    const context = { abortSignal: caller.signal, toolCallId: 'pre-aborted' };
    const release = registerToolGuardDeadlineSignal([{}, context], deadline.signal);
    try {
      const signal = resolveGuardedToolSignal(context);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(reason);
    } finally {
      release();
    }
  });

  it('publishes no deadline without a valid host context and call identity', () => {
    for (const context of [undefined, null, 'call_1', {}, { toolCallId: ' ' }]) {
      const release = registerToolGuardDeadlineSignal([{}, context], new AbortController().signal);
      expect(readToolGuardDeadlineSignal(context)).toBeUndefined();
      release();
    }
    const caller = new AbortController();
    expect(resolveGuardedToolSignal({ abortSignal: caller.signal })).toBe(caller.signal);
  });

  it('returns the execution signal untouched when no guard deadline is registered', () => {
    const execution = new AbortController();
    expect(resolveGuardedToolSignal({ abortSignal: execution.signal, toolCallId: 'none' })).toBe(
      execution.signal
    );
  });

  it('aborts when the guard gives up, even though the run signal never fired', () => {
    const execution = new AbortController();
    const guard = new AbortController();
    const context = { abortSignal: execution.signal, toolCallId: 'call-1' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      const merged = resolveGuardedToolSignal(context);
      expect(merged?.aborted).toBe(false);
      guard.abort(new Error('guard'));
      expect(merged?.aborted).toBe(true);
    } finally {
      release();
    }
  });

  it('still aborts on the run signal', () => {
    const execution = new AbortController();
    const guard = new AbortController();
    const context = { abortSignal: execution.signal, toolCallId: 'call-2' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      const merged = resolveGuardedToolSignal(context);
      execution.abort();
      expect(merged?.aborted).toBe(true);
    } finally {
      release();
    }
  });

  it('returns the guard deadline alone when the context carries no execution signal', () => {
    const guard = new AbortController();
    const context = { toolCallId: 'call-3' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      expect(resolveGuardedToolSignal(context)).toBe(guard.signal);
    } finally {
      release();
    }
  });

  it('FAILS LOUD on a present but non-AbortSignal abortSignal, never silently dropping it', () => {
    // The old `mergeCallToolSignals` path had no narrowing, so a duck-typed or
    // cross-realm signal used to be forwarded. Turning that into `undefined`
    // would silently stop the tool honouring user Stop — a silent degradation
    // the house rules forbid (PR review).
    const duckTyped = { aborted: false, addEventListener: () => undefined };
    expect(() =>
      resolveGuardedToolSignal({ abortSignal: duckTyped, toolCallId: 'call-duck' })
    ).toThrow(TypeError);
    expect(() =>
      resolveGuardedToolSignal({ abortSignal: duckTyped, toolCallId: 'call-duck' })
    ).toThrow(/non-AbortSignal abortSignal/);
    // Absent stays fine: the guard deadline alone, or nothing at all.
    expect(resolveGuardedToolSignal({ toolCallId: 'call-absent' })).toBeUndefined();
  });

  it('treats a null abortSignal as absent, never throwing (round 2, Claude C)', () => {
    // Both prior code paths tolerated `null`: `mergeCallToolSignals` forwarded
    // it, and `run-python-tool.ts`'s `context?.abortSignal ?? new
    // AbortController().signal` fell back on it. `null` is not "wrong", it is
    // "nothing there".
    expect(
      resolveGuardedToolSignal({ abortSignal: null, toolCallId: 'call-null' })
    ).toBeUndefined();

    const guard = new AbortController();
    const context = { abortSignal: null, toolCallId: 'call-null-with-guard' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    try {
      expect(resolveGuardedToolSignal(context)).toBe(guard.signal);
    } finally {
      release();
    }
  });
});
