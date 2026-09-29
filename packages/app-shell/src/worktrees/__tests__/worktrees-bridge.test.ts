import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorktreesBridgeAvailable,
  resolveWorktreesBridge,
  WORKTREES_BRIDGE_REQUIRED_METHODS,
} from '../worktrees-bridge';

function installBridge(bridge: unknown): void {
  Object.defineProperty(window, 'worktrees', { configurable: true, value: bridge, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'worktrees');
  vi.restoreAllMocks();
});

describe('resolveWorktreesBridge', () => {
  it('declares exactly the twelve ops the preload exposes', () => {
    expect([...WORKTREES_BRIDGE_REQUIRED_METHODS].sort()).toEqual([
      'adopt',
      'archive',
      'checkoutStatus',
      'create',
      'createBranchHere',
      'createContext',
      'getSettings',
      'inspectArchive',
      'list',
      'listManagedPaths',
      'restore',
      'setSettings',
    ]);
  });

  it('returns null on web (no bridge at all)', () => {
    expect(resolveWorktreesBridge()).toBeNull();
    expect(isWorktreesBridgeAvailable()).toBe(false);
  });

  it('resolves a fully-formed bridge', () => {
    const bridge = Object.fromEntries(
      WORKTREES_BRIDGE_REQUIRED_METHODS.map((method) => [method, () => Promise.resolve()])
    );
    installBridge(bridge);
    expect(resolveWorktreesBridge()).toBe(bridge);
  });

  it('DISABLES a malformed bridge wholesale and logs which methods are missing', () => {
    const bridge = Object.fromEntries(
      WORKTREES_BRIDGE_REQUIRED_METHODS.filter((method) => method !== 'list').map((method) => [
        method,
        () => Promise.resolve(),
      ])
    );
    installBridge(bridge);
    expect(resolveWorktreesBridge()).toBeNull();
  });
});
