import { describe, expect, it } from 'vitest';
import {
  registerToolGuardDeadlineSignal,
  resolveGuardedToolSignal,
} from '../tools/tool-guard-deadline';

describe('resolveGuardedToolSignal', () => {
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
      // The registry is module-global and keyed by tool-call id: a failed
      // expectation must not leak this id into every later case (PR review).
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
