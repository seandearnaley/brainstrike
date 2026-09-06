import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useRunVerdictBinding } from '../hooks/use-run-verdict';

function repositoryWith(recordRunOutcome: ReturnType<typeof vi.fn>): AssistantThreadRepository {
  return { recordRunOutcome } as unknown as AssistantThreadRepository;
}

describe('useRunVerdictBinding', () => {
  it('binds recordRunOutcome with user source and the active identifiers', async () => {
    const recordRunOutcome = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useRunVerdictBinding(repositoryWith(recordRunOutcome), 'workspace-a', 'thread-1')
    );

    expect(result.current).not.toBeNull();
    await result.current?.recordVerdict('run-1', 'succeeded');

    expect(recordRunOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: 'workspace-a',
        runId: 'run-1',
        source: 'user',
        threadId: 'thread-1',
        verdict: 'succeeded',
      })
    );
    expect(recordRunOutcome.mock.calls[0]?.[0]?.labeledAt).toBeInstanceOf(Date);
  });

  it('propagates persistence failures so the control can show a visible retry', async () => {
    const recordRunOutcome = vi.fn().mockRejectedValue(new Error('db unavailable'));
    const { result } = renderHook(() =>
      useRunVerdictBinding(repositoryWith(recordRunOutcome), 'workspace-a', 'thread-1')
    );

    await expect(result.current?.recordVerdict('run-1', 'failed')).rejects.toThrow(
      'db unavailable'
    );
  });

  // BST-1651: `recordRunOutcome` is no longer optional on the repository, so
  // the affordance can only be missing for the three reasons that genuinely
  // mean "there is nothing to label yet". It can no longer disappear because a
  // repository shape lost a method — that would have removed the verdict
  // control silently, which is exactly the degradation this codebase forbids.
  it('is null without a repository, resourceId, or threadId', () => {
    const recordRunOutcome = vi.fn();
    expect(
      renderHook(() => useRunVerdictBinding(null, 'workspace-a', 'thread-1')).result.current
    ).toBeNull();
    expect(
      renderHook(() => useRunVerdictBinding(repositoryWith(recordRunOutcome), null, 'thread-1'))
        .result.current
    ).toBeNull();
    expect(
      renderHook(() => useRunVerdictBinding(repositoryWith(recordRunOutcome), 'workspace-a', null))
        .result.current
    ).toBeNull();
  });
});
