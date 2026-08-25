import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggerMock } from './workspace-root-registry-logger-test-helper';
import { createRegistry } from './workspace-root-registry-test-helpers';

// Split out of workspace-root-registry.test.ts (BST-1390, spec §6.2): that
// file is already at the react-doctor/Biome line cap, and these tests cover a
// distinct concern — the managed-worktree authorizer wiring — rather than
// growing the existing file further.

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
  beforeEach(() => {
    loggerMock.info.mockClear();
  });

  it('routes addRootByPath through the installed managed-worktree authorizer', async () => {
    const registry = createRegistry();
    const authorizer = vi.fn(() => Promise.resolve('authorized' as const));
    registry.setManagedWorktreeAuthorizer(authorizer);
    await registry.addRootByPath('/managed/app/bright-fox');
    expect(authorizer).toHaveBeenCalledWith('/managed/app/bright-fox');
  });
});
