import {
  checkUnchangedReadWindow,
  commitRepeatedToolCall,
  editFailureHintApplies,
  MAX_KEYS_PER_THREAD_SCOPE,
  MAX_TRACKED_THREAD_SCOPES,
  peekRepeatedToolCall,
  readWindowKey,
  recordEditFailure,
  resetEditFailureStreak,
  resetToolCallLoopGuards,
  stableNormalizedArgsKey,
} from '@brainstrike/host-capabilities/native-tools';
import { beforeEach, describe, expect, it } from 'vitest';

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

describe('bounded per-thread keys', () => {
  function windowKey(path: string): string {
    return readWindowKey({
      endLine: 20,
      maxChars: 12_000,
      path,
      rootId: 'root-a',
      startLine: 10,
    });
  }

  it('preserves consecutive-call detection while unrelated keys stay under the cap', () => {
    const repeatedWindow = windowKey('/src/repeated.ts');
    checkUnchangedReadWindow('thread-a', repeatedWindow, 100);

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE - 1; index += 1) {
      checkUnchangedReadWindow('thread-a', windowKey(`/src/other-${index}.ts`), 100);
    }

    // The original plus MAX_KEYS_PER_THREAD_SCOPE - 1 others remains within
    // the configured cap, so the original observation is still present.
    expect(checkUnchangedReadWindow('thread-a', repeatedWindow, 100)).toEqual({
      count: 2,
      status: 'stub',
    });
  });

  it('keeps a repeatedly touched key through unlimited unrelated churn', () => {
    const repeatedWindow = windowKey('/src/repeated.ts');
    checkUnchangedReadWindow('thread-a', repeatedWindow, 100);

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE - 1; index += 1) {
      checkUnchangedReadWindow('thread-a', windowKey(`/src/first-${index}.ts`), 100);
    }
    expect(checkUnchangedReadWindow('thread-a', repeatedWindow, 100)).toEqual({
      count: 2,
      status: 'stub',
    });

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE - 1; index += 1) {
      checkUnchangedReadWindow('thread-a', windowKey(`/src/second-${index}.ts`), 100);
    }
    // Re-touching the window before MAX_KEYS_PER_THREAD_SCOPE other keys
    // intervene keeps it hot, even after more distinct keys have churned
    // through than the map can hold.
    expect(checkUnchangedReadWindow('thread-a', repeatedWindow, 100)).toEqual({
      count: 3,
      status: 'refuse',
    });
  });

  it('starts a streak fresh after the key itself is evicted', () => {
    const repeatedWindow = windowKey('/src/repeated.ts');
    checkUnchangedReadWindow('thread-a', repeatedWindow, 100);

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE; index += 1) {
      checkUnchangedReadWindow('thread-a', windowKey(`/src/other-${index}.ts`), 100);
    }

    // A full configured cap of unrelated calls genuinely intervened, so
    // forgetting the old read and treating this as fresh is correct.
    expect(checkUnchangedReadWindow('thread-a', repeatedWindow, 100)).toEqual({
      count: 1,
      status: 'fresh',
    });
  });

  it('preserves repeated-tool warn and refuse thresholds with a few unrelated keys', () => {
    const toolId = 'brainstrike.grepSearch';
    const input = { pattern: 'needle' };

    expect(succeed('thread-a', toolId, input)).toEqual({ count: 1, status: 'ok' });
    succeed('thread-a', 'brainstrike.otherOne', { value: 1 });
    expect(succeed('thread-a', toolId, input)).toEqual({ count: 2, status: 'ok' });
    succeed('thread-a', 'brainstrike.otherTwo', { value: 2 });
    expect(succeed('thread-a', toolId, input)).toEqual({ count: 3, status: 'warn' });
    expect(peekRepeatedToolCall('thread-a', toolId, input)).toEqual({
      count: 4,
      status: 'refuse',
    });
  });

  it('evicts a repeated-tool streak after the configured number of other tool IDs', () => {
    const toolId = 'brainstrike.grepSearch';
    const input = { pattern: 'needle' };
    succeed('thread-a', toolId, input);
    succeed('thread-a', toolId, input);

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE; index += 1) {
      succeed('thread-a', `brainstrike.other-${index}`, { value: index });
    }

    expect(peekRepeatedToolCall('thread-a', toolId, input)).toEqual({
      count: 1,
      status: 'ok',
    });
  });

  it('preserves edit-failure escalation with a few unrelated keys', () => {
    expect(recordEditFailure('thread-a', 'root-a', '/src/repeated.ts')).toBe(1);
    recordEditFailure('thread-a', 'root-a', '/src/other-one.ts');
    expect(recordEditFailure('thread-a', 'root-a', '/src/repeated.ts')).toBe(2);
    recordEditFailure('thread-a', 'root-a', '/src/other-two.ts');
    const count = recordEditFailure('thread-a', 'root-a', '/src/repeated.ts');

    expect(count).toBe(3);
    expect(editFailureHintApplies(count)).toBe(true);
  });

  it('evicts an edit-failure streak after the configured number of other paths', () => {
    const repeatedPath = '/src/repeated.ts';
    recordEditFailure('thread-a', 'root-a', repeatedPath);
    recordEditFailure('thread-a', 'root-a', repeatedPath);

    for (let index = 0; index < MAX_KEYS_PER_THREAD_SCOPE; index += 1) {
      recordEditFailure('thread-a', 'root-a', `/src/other-${index}.ts`);
    }

    expect(recordEditFailure('thread-a', 'root-a', repeatedPath)).toBe(1);
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

describe('bounded thread scopes', () => {
  it('evicts the least-recently-active scope under many-thread load', () => {
    const keptWarmScope = 'thread-5';
    let keptWarmCount = 0;
    const refreshInterval = Math.max(1, Math.floor(MAX_TRACKED_THREAD_SCOPES / 4));

    for (let index = 0; index < MAX_TRACKED_THREAD_SCOPES + 5; index += 1) {
      const threadScope = `thread-${index}`;
      const count = recordEditFailure(threadScope, 'root-a', '/src/main.ts');
      if (threadScope === keptWarmScope) {
        keptWarmCount = count;
      }
      if (index >= refreshInterval && index % refreshInterval === 0) {
        keptWarmCount = recordEditFailure(keptWarmScope, 'root-a', '/src/main.ts');
      }
    }

    // Scope 5 survives because later writes repeatedly promoted its activity;
    // FIFO eviction based only on first insertion would reset this to one.
    expect(recordEditFailure(keptWarmScope, 'root-a', '/src/main.ts')).toBe(keptWarmCount + 1);
    // Scope 3 was never active again after its first write and was evicted.
    expect(recordEditFailure('thread-3', 'root-a', '/src/main.ts')).toBe(1);
  });

  it('keeps a refuse-only repeated-call scope hot through read-path activity', () => {
    const input = { pattern: 'needle' };
    const threadScope = 'thread-refuser';
    const toolId = 'brainstrike.grepSearch';
    succeed(threadScope, toolId, input);
    succeed(threadScope, toolId, input);
    expect(succeed(threadScope, toolId, input)).toEqual({ count: 3, status: 'warn' });
    expect(peekRepeatedToolCall(threadScope, toolId, input)).toEqual({
      count: 4,
      status: 'refuse',
    });

    for (let index = 0; index < MAX_TRACKED_THREAD_SCOPES; index += 1) {
      recordEditFailure(`thread-other-${index}`, 'root-a', '/src/main.ts');
      expect(peekRepeatedToolCall(threadScope, toolId, input)).toEqual({
        count: 4,
        status: 'refuse',
      });
    }

    expect(peekRepeatedToolCall(threadScope, toolId, input)).toEqual({
      count: 4,
      status: 'refuse',
    });
  });

  it('still evicts a genuinely idle repeated-call scope', () => {
    const input = { pattern: 'needle' };
    const threadScope = 'thread-idle';
    const toolId = 'brainstrike.grepSearch';
    succeed(threadScope, toolId, input);
    succeed(threadScope, toolId, input);

    for (let index = 0; index < MAX_TRACKED_THREAD_SCOPES; index += 1) {
      recordEditFailure(`thread-other-${index}`, 'root-a', '/src/main.ts');
    }

    expect(peekRepeatedToolCall(threadScope, toolId, input)).toEqual({
      count: 1,
      status: 'ok',
    });
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
