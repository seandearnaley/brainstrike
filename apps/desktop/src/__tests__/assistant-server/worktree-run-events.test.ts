/**
 * Unit lane for the `worktree.created` provenance discriminator (BST-1392).
 * `via` is the ONLY field distinguishing how a managed worktree came to
 * exist — 'app' (the create sheet) vs 'adopt' (an externally created worktree
 * BrainStrike now manages) today, with more provenances planned. Everything
 * else about the two emitters' payloads is already covered by the real-PGlite
 * `worktree-run-events.integration.test.ts`; this lane only pins the field
 * that integration suite never inspected.
 */
import type { AssistantRunEvent } from '@brainstrike/agent';
import type { ManagedWorktreeRow, WorktreeSetupOutcome } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  emitWorktreeAdoptedEvent,
  emitWorktreeCreateEvents,
} from '../../assistant-server/worktree-run-events';

const WORKTREE: ManagedWorktreeRow = {
  archivedAt: null,
  archiveSnapshotRef: null,
  baseRef: 'main',
  branch: 'bs/example',
  createdAt: '2026-08-26T00:00:00.000Z',
  createdBy: 'user',
  id: 'w-1',
  path: '/repo/wt',
  repoCommonDir: '/repo/.git',
  runId: null,
  setupOutput: null,
  setupReason: null,
  setupStatus: 'none',
  threadId: null,
};

const NO_SETUP: WorktreeSetupOutcome = {
  copiedPaths: [],
  output: '',
  reason: null,
  skippedCopies: [],
  status: 'none',
  truncated: false,
};

describe('worktree.created provenance', () => {
  it("marks a created worktree's event via 'app' and an adopted worktree's via 'adopt'", async () => {
    const recordRunEvent = vi.fn(async (_runId: string, _event: AssistantRunEvent) => undefined);

    await emitWorktreeCreateEvents({ recordRunEvent }, 'run-created', WORKTREE, NO_SETUP);
    await emitWorktreeAdoptedEvent({ recordRunEvent }, 'run-adopted', WORKTREE);

    expect(recordRunEvent).toHaveBeenCalledTimes(2);
    const [createdCall, adoptedCall] = recordRunEvent.mock.calls;

    expect(createdCall?.[0]).toBe('run-created');
    expect(createdCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      metadata: { via: 'app' },
    });

    expect(adoptedCall?.[0]).toBe('run-adopted');
    expect(adoptedCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      metadata: { via: 'adopt' },
    });

    // Falsifier: the two `worktree.created` events must not collapse to the
    // same provenance — this is what would happen if `via` were dropped or
    // hardcoded on either emitter.
    const createdMetadata = createdCall?.[1]?.metadata as { via?: string } | undefined;
    const adoptedMetadata = adoptedCall?.[1]?.metadata as { via?: string } | undefined;
    expect(createdMetadata?.via).not.toBe(adoptedMetadata?.via);
  });
});
