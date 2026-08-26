import { describe, expect, it } from 'vitest';
import {
  ListWorktreesInputSchema,
  ManageWorktreeInputSchema,
  normalizeManageWorktreeInput,
} from '../tools/schemas-worktrees';

describe('ListWorktreesInputSchema', () => {
  it('accepts an empty object and an explicit root', () => {
    expect(ListWorktreesInputSchema.parse({})).toEqual({});
    expect(ListWorktreesInputSchema.parse({ root: 'brainstrike' })).toEqual({
      root: 'brainstrike',
    });
  });

  it('rejects an unknown key at the strict provider envelope', () => {
    expect(() => ListWorktreesInputSchema.parse({ rootId: 'x' })).toThrow();
  });
});

describe('ManageWorktreeInputSchema', () => {
  it('accepts a create with a branch', () => {
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox' })
    ).not.toThrow();
  });

  it('rejects a create with no branch, naming the missing field', () => {
    const result = ManageWorktreeInputSchema.safeParse({ action: 'create' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('branch');
  });

  it('rejects an archive with no worktreeId', () => {
    expect(ManageWorktreeInputSchema.safeParse({ action: 'archive' }).success).toBe(false);
  });

  it('accepts an archive with a worktreeId', () => {
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'archive', worktreeId: 'wt-9' })
    ).not.toThrow();
  });

  it('tolerates cross-action extras among the declared envelope keys', () => {
    // The settled manageCanvas ruling (2026-08-07): real models bundle fields,
    // and rejecting a VALID create that carries a stray worktreeId burns retry
    // tokens for nothing. `action` fully determines semantics.
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).not.toThrow();
  });

  it('rejects a genuinely unknown key', () => {
    expect(() =>
      ManageWorktreeInputSchema.parse({ action: 'create', branch: 'bs/fox', detach: true })
    ).toThrow();
  });

  it('normalizes to the clean action branch, stripping tolerated extras', () => {
    expect(
      normalizeManageWorktreeInput({ action: 'create', branch: 'bs/fox', worktreeId: 'wt-1' })
    ).toEqual({ action: 'create', branch: 'bs/fox' });
  });
});
