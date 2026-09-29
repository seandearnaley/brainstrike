/**
 * The claim a leg holds between admission and native resume (BST-1749, PR
 * #3209 review): nothing native has run, so a failure releases it through the
 * owner that took it — the delegated ledger, or the continuation host for a
 * child continuation decision — and propagates the original failure.
 */
import { describe, expect, it, vi } from 'vitest';
import { beforeDelegatedToolActionResume } from '../delegated-tool-actions';

const delegation = {
  path: [
    {
      childRuntimeRunId: 'child-run',
      parentRuntimeRunId: 'root-run',
      parentToolCallId: 'delegate-1',
      personaId: 'explore',
    },
  ],
  toolCallId: 'child-call',
};
const action = { delegation, runId: 'root-run', toolCallId: 'delegate-1' };

function bindingWith(overrides: Record<string, unknown>) {
  return overrides as unknown as Parameters<typeof beforeDelegatedToolActionResume>[1];
}

describe('beforeDelegatedToolActionResume', () => {
  it('returns the work result untouched and releases nothing when it succeeds', async () => {
    const releaseUnexecutedToolAction = vi.fn(async () => undefined);
    await expect(
      beforeDelegatedToolActionResume(
        action,
        bindingWith({ releaseUnexecutedToolAction }),
        { requiresApproval: true },
        async () => Promise.resolve('resumes')
      )
    ).resolves.toBe('resumes');
    expect(releaseUnexecutedToolAction).not.toHaveBeenCalled();
  });

  it("releases the delegated claim when the leg's pre-resume work fails, and keeps the original error", async () => {
    const releaseUnexecutedToolAction = vi.fn(async () => undefined);
    const failure = Object.assign(new Error('refused'), { reason: 'tool-action-stopped' });
    await expect(
      beforeDelegatedToolActionResume(
        action,
        bindingWith({ releaseUnexecutedToolAction }),
        { requiresApproval: true },
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure);
    expect(releaseUnexecutedToolAction).toHaveBeenCalledWith(action);
  });

  it('releases a child continuation claim through its continuation owner, never the delegated ledger', async () => {
    // MUTATION GUARD: releasing through `releaseUnexecutedToolAction` here
    // rolls back a claim this leg never took and leaves the continuation
    // decision claimed.
    const releaseUnexecutedContinuationDecision = vi.fn(async () => undefined);
    const releaseUnexecutedToolAction = vi.fn(async () => undefined);
    const continuationAction = { ...action, continuationId: 'continuation-1' };
    const failure = new Error('refused');
    await expect(
      beforeDelegatedToolActionResume(
        continuationAction,
        bindingWith({
          continuation: { releaseUnexecutedContinuationDecision },
          releaseUnexecutedToolAction,
        }),
        { requiresApproval: true },
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure);
    expect(releaseUnexecutedToolAction).not.toHaveBeenCalled();
    expect(releaseUnexecutedContinuationDecision).toHaveBeenCalledWith({
      delegation,
      id: 'continuation-1',
      kind: 'tool-approval',
      nativeRunId: 'root-run',
      toolCallId: 'delegate-1',
    });
  });

  it('releases nothing for a root decision, which holds no delegated claim', async () => {
    const releaseUnexecutedToolAction = vi.fn(async () => undefined);
    const failure = new Error('refused');
    await expect(
      beforeDelegatedToolActionResume(
        { runId: 'root-run', toolCallId: 'root-call' },
        bindingWith({ releaseUnexecutedToolAction }),
        { requiresApproval: true },
        () => Promise.reject(failure)
      )
    ).rejects.toBe(failure);
    expect(releaseUnexecutedToolAction).not.toHaveBeenCalled();
  });

  it('keeps the original failure reachable when the release itself fails', async () => {
    const failure = Object.assign(new Error('refused'), { reason: 'tool-action-stopped' });
    const releaseError = new Error('release failed');
    const rejection = await beforeDelegatedToolActionResume(
      action,
      bindingWith({
        releaseUnexecutedToolAction: () => Promise.reject(releaseError),
      }),
      { requiresApproval: true },
      () => Promise.reject(failure)
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    // MUTATION GUARD: an AggregateError without `cause` loses the host's
    // `reason`/`code` for every caller that reads it.
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([failure, releaseError]);
    expect((rejection as { cause?: unknown }).cause).toBe(failure);
  });
});
