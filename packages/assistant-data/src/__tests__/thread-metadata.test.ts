import { describe, expect, it } from 'vitest';
import {
  assertPersistableThreadMetadataForTest,
  sanitizeThreadMetadataForTest,
} from '../assistant-memory-repository';

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
  it('keeps a complete worktree checkout through the sanitizer', () => {
    const metadata = sanitizeThreadMetadataForTest({
      checkoutBranch: 'feature/x',
      checkoutMode: 'worktree',
      checkoutWorktreeId: '0198f6a0-0000-7000-8000-000000000001',
      checkoutWorktreePath: '/repos/acme/.brainstrike/worktrees/feature-x',
    });
    expect(metadata).toEqual({
      checkoutBranch: 'feature/x',
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
