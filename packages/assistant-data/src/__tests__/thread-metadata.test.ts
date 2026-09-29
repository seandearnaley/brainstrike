import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it } from 'vitest';
import {
  assertPersistableThreadMetadataForTest,
  createPgliteAssistantThreadRepository,
  sanitizeThreadMetadataForTest,
} from '../assistant-memory-repository';
import { createMigratedTestPGlite } from './helpers/test-pglite';

let pgliteDataDir: string | undefined;

describe('forge metadata', () => {
  it('keeps a forge PR URL and a watch flag', () => {
    const metadata = sanitizeThreadMetadataForTest({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
    expect(metadata).toEqual({
      forgePrUrl: 'https://github.com/acme/widgets/pull/42',
      forgePrWatch: false,
    });
  });

  it('drops a non-string forge PR URL and a non-boolean watch flag', () => {
    expect(sanitizeThreadMetadataForTest({ forgePrUrl: 42, forgePrWatch: 'yes' })).toBeUndefined();
  });

  it('rejects an unknown forge key on persistence', () => {
    expect(() => assertPersistableThreadMetadataForTest({ forgePr: 'x' } as never)).toThrow(
      'Invalid assistant thread metadata key: forgePr.'
    );
  });

  it('rejects a blank forge PR URL on persistence', () => {
    expect(() => assertPersistableThreadMetadataForTest({ forgePrUrl: '   ' })).toThrow();
  });
});

describe('checkout metadata', () => {
  it('removes persisted worktree keys when handing a thread back to local', async () => {
    pgliteDataDir = `memory://thread-metadata-local-handoff-${crypto.randomUUID()}`;
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await repository.updateThreadMetadata(thread.id, {
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });
    await repository.updateThreadMetadata(thread.id, { checkoutMode: 'local' });

    const [reloaded] = await repository.listThreads('workspace-a');
    expect(reloaded?.metadata).toMatchObject({ checkoutMode: 'local' });
    expect(reloaded?.metadata?.checkoutBranch).toBeUndefined();
    expect(reloaded?.metadata?.checkoutLocalRootId).toBeUndefined();
    expect(reloaded?.metadata?.checkoutWorktreeId).toBeUndefined();
    expect(reloaded?.metadata?.checkoutWorktreePath).toBeUndefined();
  });

  it('rejects checkout keys from bulk repository updates before writing', async () => {
    pgliteDataDir = `memory://thread-metadata-bulk-checkout-${crypto.randomUUID()}`;
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await expect(
      repository.updateThreadsMetadata?.([thread.id], { checkoutMode: 'local' })
    ).rejects.toThrow('Bulk assistant thread metadata updates cannot change checkout state.');

    const [reloaded] = await repository.listThreads('workspace-a');
    expect(reloaded?.metadata).toEqual({ source: 'brainstrike' });
  });

  it('keeps a complete worktree checkout through the sanitizer', () => {
    const metadata = sanitizeThreadMetadataForTest({
      checkoutBranch: 'feature/x',
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
    });
    expect(metadata).toEqual({
      checkoutBranch: 'feature/x',
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
    });
  });

  it('throws on an inconsistent stored row (local mode with worktree keys) instead of pruning', () => {
    expect(() =>
      sanitizeThreadMetadataForTest({
        checkoutMode: 'local',
        checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
        checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
      })
    ).toThrow('Assistant thread checkout metadata is inconsistent.');
  });

  it('throws on a local checkout carrying a durable Local root id', () => {
    expect(() =>
      sanitizeThreadMetadataForTest({
        checkoutLocalRootId: 'r-local',
        checkoutMode: 'local',
      })
    ).toThrow('Assistant thread checkout metadata is inconsistent.');
  });

  it('loads a legacy worktree checkout with no durable Local root id', () => {
    const metadata = sanitizeThreadMetadataForTest({
      checkoutMode: 'worktree',
      checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
    });

    expect(metadata).toEqual({
      checkoutMode: 'worktree',
      checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
    });
    expect(metadata?.checkoutLocalRootId).toBeUndefined();
  });

  it('rejects persistence of a worktree checkout missing its durable Local root id', () => {
    expect(() =>
      assertPersistableThreadMetadataForTest({
        checkoutMode: 'worktree',
        checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
        checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
      })
    ).toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('removes a stale branch on a detached worktree-to-worktree transition', async () => {
    pgliteDataDir = `memory://thread-metadata-worktree-transition-${crypto.randomUUID()}`;
    const db = await createMigratedTestPGlite(pgliteDataDir);
    const repository = createPgliteAssistantThreadRepository(db as DbHandle);
    const thread = await repository.createThread('workspace-a');

    await repository.updateThreadMetadata(thread.id, {
      checkoutBranch: 'bs/bright-fox',
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });
    await repository.updateThreadMetadata(thread.id, {
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-2',
      checkoutWorktreePath: '/managed/repo/detached',
    });

    const [reloaded] = await repository.listThreads('workspace-a');
    expect(reloaded?.metadata).toMatchObject({
      checkoutLocalRootId: 'r-local',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-2',
      checkoutWorktreePath: '/managed/repo/detached',
    });
    expect(reloaded?.metadata?.checkoutBranch).toBeUndefined();
  });

  it('throws on a mode-less worktree id instead of guessing a mode', () => {
    expect(() =>
      sanitizeThreadMetadataForTest({
        checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      })
    ).toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('rejects an unknown checkout mode', () => {
    expect(() => sanitizeThreadMetadataForTest({ checkoutMode: 'detached' })).toThrow(
      'Invalid assistant thread metadata checkout mode.'
    );
  });

  it('rejects an incomplete checkout patch on persistence', () => {
    expect(() => assertPersistableThreadMetadataForTest({ checkoutMode: 'worktree' })).toThrow(
      'Assistant thread checkout metadata is incomplete.'
    );
  });
});
