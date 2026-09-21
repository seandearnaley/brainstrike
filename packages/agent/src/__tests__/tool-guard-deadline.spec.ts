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
    const merged = resolveGuardedToolSignal(context);
    expect(merged?.aborted).toBe(false);
    guard.abort(new Error('guard'));
    expect(merged?.aborted).toBe(true);
    release();
  });

  it('still aborts on the run signal', () => {
    const execution = new AbortController();
    const guard = new AbortController();
    const context = { abortSignal: execution.signal, toolCallId: 'call-2' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    const merged = resolveGuardedToolSignal(context);
    execution.abort();
    expect(merged?.aborted).toBe(true);
    release();
  });

  it('returns the guard deadline alone when the context carries no execution signal', () => {
    const guard = new AbortController();
    const context = { toolCallId: 'call-3' };
    const release = registerToolGuardDeadlineSignal([{}, context], guard.signal);
    expect(resolveGuardedToolSignal(context)).toBe(guard.signal);
    release();
  });
});
