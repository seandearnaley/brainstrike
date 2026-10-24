import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRegistry } from './workspace-root-registry-test-helpers';

// Split out of workspace-root-registry.test.ts (BST-1390, spec §6.2): the
// managed-worktree authorizer wiring is a distinct concern from the general
// registry behavior, so it lives in its own file (the sibling suite also sits
// near the Biome line cap).

const MANAGED = path.resolve('/managed/app/bright-fox');

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const { loggerMock: sharedLoggerMock } = await import(
    './workspace-root-registry-logger-test-helper'
  );
  return {
    ...(await importOriginal<typeof import('@brainstrike/logging')>()),
    createLogger: () => sharedLoggerMock,
  };
});

describe('WorkspaceRootRegistry managed-worktree authorizer (BST-1390, spec §6.2)', () => {
  it('routes addRootByPath through the installed managed-worktree authorizer', async () => {
    const registry = createRegistry();
    const authorizer = vi.fn(() => Promise.resolve('authorized' as const));
    registry.setManagedWorktreeAuthorizer(authorizer);
    await registry.addRootByPath(MANAGED);
    expect(authorizer).toHaveBeenCalledWith(MANAGED);
  });

  it('does NOT notify onRootGranted for a managed-worktree mount (BST-1393 review finding)', async () => {
    // The registry already excludes managed-worktree grants from the recents
    // ledger (recordInRecentRoots: false); onRootGranted rides the SAME gate,
    // so a scratch worktree must never reach the OS recent-documents list.
    const onRootGranted = vi.fn();
    const registry = createRegistry({ onRootGranted });
    registry.setManagedWorktreeAuthorizer(() => Promise.resolve('authorized'));
    await registry.addRootByPath(MANAGED);
    expect(onRootGranted).not.toHaveBeenCalled();
  });
});
