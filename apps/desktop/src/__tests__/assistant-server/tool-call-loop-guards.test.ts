import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkUnchangedReadWindow,
  commitRepeatedToolCall,
  editFailureHintApplies,
  peekRepeatedToolCall,
  readWindowKey,
  recordEditFailure,
  resetEditFailureStreak,
  resetToolCallLoopGuards,
  stableNormalizedArgsKey,
} from '../../assistant-server/tool-call-loop-guards';

beforeEach(() => {
  resetToolCallLoopGuards();
});

/** Simulate a SUCCESSFUL call: peek, then commit the peeked count — the
 * sequence `withRepeatedCallGuard` performs around a `run` that resolves. */
function succeed(threadScope: string, toolId: string, args: unknown) {
  const peek = peekRepeatedToolCall(threadScope, toolId, args);
  commitRepeatedToolCall(threadScope, toolId, args, peek.count);
  return peek;
}

describe('repeated identical tool calls', () => {
  it('warns on the third call and refuses the fourth and later calls', () => {
    expect(succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 1,
      status: 'ok',
    });
    expect(succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 2,
      status: 'ok',
    });
    expect(succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 3,
      status: 'warn',
    });
    expect(succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 4,
      status: 'refuse',
    });
    // A 'refuse' peek is never committed by a real caller (the call is never
    // run) — a fifth PEEK against the same last-committed count (4) still
    // sees the streak as 5-in-a-row and keeps refusing.
    expect(
      peekRepeatedToolCall('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })
    ).toEqual({
      count: 5,
      status: 'refuse',
    });
  });

  it('does not advance the streak when a call fails (peek without commit)', () => {
    // Two successful calls, then two THROWING attempts with the same args:
    // real callers never call `commitRepeatedToolCall` after a throw.
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    expect(
      peekRepeatedToolCall('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })
    ).toEqual({ count: 3, status: 'warn' });
    // Simulate the 3rd attempt THROWING: peek but never commit.
    peekRepeatedToolCall('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    // A retry with the SAME args peeks the SAME count again — the failed
    // attempt did not advance the streak, so this is still the 3rd
    // real attempt, not the 4th.
    expect(
      peekRepeatedToolCall('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })
    ).toEqual({ count: 3, status: 'warn' });
  });

  it('resets only the same tool when its arguments change', () => {
    const toolId = 'brainstrike.grepSearch';
    succeed('thread-a', toolId, { pattern: 'first' });
    succeed('thread-a', toolId, { pattern: 'first' });

    expect(succeed('thread-a', toolId, { pattern: 'second' })).toEqual({
      count: 1,
      status: 'ok',
    });
    expect(succeed('thread-a', toolId, { pattern: 'first' })).toEqual({
      count: 1,
      status: 'ok',
    });
  });

  it('keeps independent per-tool streaks when calls are interleaved', () => {
    const grepId = 'brainstrike.grepSearch';
    const globId = 'brainstrike.globWorkspace';

    expect(succeed('thread-a', grepId, { pattern: 'needle' }).count).toBe(1);
    expect(succeed('thread-a', globId, { pattern: '*.ts' }).count).toBe(1);
    expect(succeed('thread-a', grepId, { pattern: 'needle' }).count).toBe(2);
    expect(succeed('thread-a', globId, { pattern: '*.ts' }).count).toBe(2);
    expect(succeed('thread-a', grepId, { pattern: 'needle' })).toEqual({
      count: 3,
      status: 'warn',
    });
    expect(succeed('thread-a', globId, { pattern: '*.ts' })).toEqual({
      count: 3,
      status: 'warn',
    });
  });

  it('isolates streaks by thread scope', () => {
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });

    expect(succeed('thread-b', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 1,
      status: 'ok',
    });
    expect(succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' })).toEqual({
      count: 3,
      status: 'warn',
    });
  });
});

describe('stableNormalizedArgsKey', () => {
  it('sorts object keys recursively and drops undefined values', () => {
    const left = {
      omitted: undefined,
      outer: { alpha: 1, beta: 2, omitted: undefined },
      zeta: true,
    };
    const right = {
      outer: { alpha: 1, beta: 2, omitted: undefined },
      zeta: true,
    };

    expect(stableNormalizedArgsKey(left)).toBe(stableNormalizedArgsKey(right));
  });

  it('preserves array order', () => {
    expect(stableNormalizedArgsKey({ paths: ['a', 'b'] })).not.toBe(
      stableNormalizedArgsKey({ paths: ['b', 'a'] })
    );
  });
});

describe('unchanged read windows', () => {
  it('returns fresh, then stub, then refusal for the same unchanged window', () => {
    const windowKey = readWindowKey({
      endLine: 20,
      maxChars: 12_000,
      path: '/src/main.ts',
      rootId: 'root-a',
      startLine: 10,
    });

    expect(checkUnchangedReadWindow('thread-a', windowKey, 100)).toEqual({
      count: 1,
      status: 'fresh',
    });
    expect(checkUnchangedReadWindow('thread-a', windowKey, 100)).toEqual({
      count: 2,
      status: 'stub',
    });
    expect(checkUnchangedReadWindow('thread-a', windowKey, 100)).toEqual({
      count: 3,
      status: 'refuse',
    });
  });

  it('resets the window when the mtime changes', () => {
    const windowKey = readWindowKey({
      endLine: undefined,
      maxChars: 12_000,
      path: '/README.md',
      rootId: 'root-a',
      startLine: undefined,
    });
    checkUnchangedReadWindow('thread-a', windowKey, 100);

    expect(checkUnchangedReadWindow('thread-a', windowKey, 101)).toEqual({
      count: 1,
      status: 'fresh',
    });
  });

  it('keeps different paths and line windows independent', () => {
    const first = readWindowKey({
      endLine: 10,
      maxChars: 12_000,
      path: '/src/main.ts',
      rootId: 'root-a',
      startLine: 1,
    });
    const otherRange = readWindowKey({
      endLine: 20,
      maxChars: 12_000,
      path: '/src/main.ts',
      rootId: 'root-a',
      startLine: 11,
    });
    const otherPath = readWindowKey({
      endLine: 10,
      maxChars: 12_000,
      path: '/src/other.ts',
      rootId: 'root-a',
      startLine: 1,
    });
    checkUnchangedReadWindow('thread-a', first, 100);

    expect(checkUnchangedReadWindow('thread-a', otherRange, 100)).toEqual({
      count: 1,
      status: 'fresh',
    });
    expect(checkUnchangedReadWindow('thread-a', otherPath, 100)).toEqual({
      count: 1,
      status: 'fresh',
    });
    expect(checkUnchangedReadWindow('thread-a', first, 100)).toEqual({
      count: 2,
      status: 'stub',
    });
  });

  it('treats a different maxChars as a different window (a bigger budget is new information)', () => {
    const smallBudget = readWindowKey({
      endLine: undefined,
      maxChars: 500,
      path: '/big.ts',
      rootId: 'root-a',
      startLine: undefined,
    });
    const largeBudget = readWindowKey({
      endLine: undefined,
      maxChars: 200_000,
      path: '/big.ts',
      rootId: 'root-a',
      startLine: undefined,
    });
    checkUnchangedReadWindow('thread-a', smallBudget, 100);
    checkUnchangedReadWindow('thread-a', smallBudget, 100);

    expect(checkUnchangedReadWindow('thread-a', largeBudget, 100)).toEqual({
      count: 1,
      status: 'fresh',
    });
  });
});

describe('edit failure streaks', () => {
  it('applies the escalation at three failures and keeps it active afterward', () => {
    const counts = [
      recordEditFailure('thread-a', 'root-a', '/src/main.ts'),
      recordEditFailure('thread-a', 'root-a', '/src/main.ts'),
      recordEditFailure('thread-a', 'root-a', '/src/main.ts'),
      recordEditFailure('thread-a', 'root-a', '/src/main.ts'),
    ];

    expect(counts).toEqual([1, 2, 3, 4]);
    expect(counts.map(editFailureHintApplies)).toEqual([false, false, true, true]);
  });

  it('starts again at one after a successful-edit reset', () => {
    recordEditFailure('thread-a', 'root-a', '/src/main.ts');
    recordEditFailure('thread-a', 'root-a', '/src/main.ts');
    resetEditFailureStreak('thread-a', 'root-a', '/src/main.ts');

    expect(recordEditFailure('thread-a', 'root-a', '/src/main.ts')).toBe(1);
  });
});

describe('resetToolCallLoopGuards', () => {
  it('clears only the requested scope', () => {
    const readKey = readWindowKey({
      endLine: null,
      maxChars: 12_000,
      path: '/README.md',
      rootId: 'root-a',
      startLine: null,
    });
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    succeed('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' });
    succeed('thread-b', 'brainstrike.grepSearch', { pattern: 'needle' });
    succeed('thread-b', 'brainstrike.grepSearch', { pattern: 'needle' });
    checkUnchangedReadWindow('thread-a', readKey, 100);
    checkUnchangedReadWindow('thread-b', readKey, 100);
    recordEditFailure('thread-a', 'root-a', '/README.md');
    recordEditFailure('thread-b', 'root-a', '/README.md');

    resetToolCallLoopGuards('thread-a');

    expect(
      peekRepeatedToolCall('thread-a', 'brainstrike.grepSearch', { pattern: 'needle' }).count
    ).toBe(1);
    expect(
      peekRepeatedToolCall('thread-b', 'brainstrike.grepSearch', { pattern: 'needle' }).count
    ).toBe(3);
    expect(checkUnchangedReadWindow('thread-a', readKey, 100).count).toBe(1);
    expect(checkUnchangedReadWindow('thread-b', readKey, 100).count).toBe(2);
    expect(recordEditFailure('thread-a', 'root-a', '/README.md')).toBe(1);
    expect(recordEditFailure('thread-b', 'root-a', '/README.md')).toBe(2);
  });

  it('clears every scope when omitted', () => {
    recordEditFailure('thread-a', 'root-a', '/src/main.ts');
    recordEditFailure('thread-b', 'root-a', '/src/main.ts');

    resetToolCallLoopGuards();

    expect(recordEditFailure('thread-a', 'root-a', '/src/main.ts')).toBe(1);
    expect(recordEditFailure('thread-b', 'root-a', '/src/main.ts')).toBe(1);
  });
});
