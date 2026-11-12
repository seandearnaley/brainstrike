/**
 * ADR-0034: a thread's checkout has one name on every surface (the Threads
 * panel's chip, the composer's where-control and the Explorer's header):
 * `Local`, or its worktree's folder name.
 */
import { describe, expect, it } from 'vitest';
import { checkoutName, pathFolderName } from '../thread-checkout-name.ts';

describe('checkoutName', () => {
  it('calls a thread with no worktree Local, a git repository or not', () => {
    expect(checkoutName(null)).toBe('Local');
    expect(checkoutName(undefined)).toBe('Local');
  });

  it('names a worktree by its folder, on either path separator', () => {
    expect(checkoutName('/managed/brainstrike/swift-badger')).toBe('swift-badger');
    expect(checkoutName('/managed/brainstrike/swift-badger/')).toBe('swift-badger');
    expect(checkoutName('C:\\worktrees\\brainstrike\\swift-badger')).toBe('swift-badger');
  });

  it('keeps a worktree path that names no folder as it is', () => {
    expect(checkoutName('/')).toBe('/');
  });
});

describe('pathFolderName', () => {
  it("is a path's last folder, or nothing for a path that names none", () => {
    expect(pathFolderName('/ws/brainstrike')).toBe('brainstrike');
    expect(pathFolderName('/')).toBeUndefined();
  });
});
