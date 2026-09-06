/**
 * Unit lane for the `worktree.created` provenance discriminator (BST-1392).
 * `via` is the ONLY field distinguishing how a managed worktree came to
 * exist — 'app' (the create sheet), 'tool' (the `brainstrike.manageWorktree`
 * agent tool), 'adopt' (an externally created worktree BrainStrike now
 * manages), or 'shell' (an agent command). Everything else about the
 * emitters' payloads is already covered by the real-PGlite
 * `worktree-run-events.integration.test.ts`; this lane only pins the field
 * that integration suite never inspected.
 */
import type { AssistantRunEvent } from '@brainstrike/agent';
import type { ManagedWorktreeRow, WorktreeSetupOutcome } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  emitWorktreeAdoptedEvent,
  emitWorktreeCreateEvents,
  emitWorktreeShellCreatedEvent,
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
  it("distinguishes 'app', 'tool', 'adopt', and 'shell' creation events", async () => {
    const recordRunEvent = vi.fn(async (_runId: string, _event: AssistantRunEvent) => undefined);

    await emitWorktreeCreateEvents({ recordRunEvent }, 'run-created', WORKTREE, NO_SETUP);
    await emitWorktreeCreateEvents(
      { recordRunEvent },
      'run-tool',
      { ...WORKTREE, createdBy: 'agent', runId: 'run-tool' },
      NO_SETUP
    );
    await emitWorktreeAdoptedEvent({ recordRunEvent }, 'run-adopted', WORKTREE);
    await emitWorktreeShellCreatedEvent({ recordRunEvent }, 'run-shell', WORKTREE);

    expect(recordRunEvent).toHaveBeenCalledTimes(4);
    const [createdCall, toolCall, adoptedCall, shellCall] = recordRunEvent.mock.calls;

    expect(createdCall?.[0]).toBe('run-created');
    expect(createdCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      metadata: { via: 'app' },
    });

    // The SAME emitter serves both create call sites (the Mode chip's IPC
    // handler and the manageWorktree tool executor); the row's `createdBy`
    // — bound by each call site — is what selects the pathway breadcrumb.
    expect(toolCall?.[0]).toBe('run-tool');
    expect(toolCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      metadata: { via: 'tool' },
    });

    expect(adoptedCall?.[0]).toBe('run-adopted');
    expect(adoptedCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      metadata: { via: 'adopt' },
    });

    expect(shellCall?.[0]).toBe('run-shell');
    expect(shellCall?.[1]).toMatchObject({
      kind: 'worktree.created',
      label: 'Agent created worktree wt (via shell)',
      metadata: { via: 'shell' },
    });

    // Falsifier: no two `worktree.created` events may collapse to the same
    // provenance — this is what would happen if `via` were dropped or
    // hardcoded on any emitter. `created` vs `tool` is the pair that DID
    // collapse before BST-1392 threaded `createdBy` into the breadcrumb.
    const createdMetadata = createdCall?.[1]?.metadata as { via?: string } | undefined;
    const toolMetadata = toolCall?.[1]?.metadata as { via?: string } | undefined;
    const adoptedMetadata = adoptedCall?.[1]?.metadata as { via?: string } | undefined;
    const shellMetadata = shellCall?.[1]?.metadata as { via?: string } | undefined;
    expect(createdMetadata?.via).not.toBe(toolMetadata?.via);
    expect(createdMetadata?.via).not.toBe(adoptedMetadata?.via);
    expect(toolMetadata?.via).not.toBe(shellMetadata?.via);
    expect(shellMetadata?.via).not.toBe(adoptedMetadata?.via);
  });
});
