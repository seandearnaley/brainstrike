import { describe, expect, it } from 'vitest';
import { resolveChildToolCallConcurrency } from '../build-persona-subagents';

describe('resolveChildToolCallConcurrency', () => {
  it('runs an approval-resume leg sequentially and every other leg in parallel', () => {
    expect(resolveChildToolCallConcurrency(true)).toEqual({ limit: 1, strategy: 'called' });
    expect(resolveChildToolCallConcurrency(false)).toEqual({ limit: 8, strategy: 'called' });
    expect(resolveChildToolCallConcurrency(undefined)).toEqual({ limit: 8, strategy: 'called' });
  });
});
