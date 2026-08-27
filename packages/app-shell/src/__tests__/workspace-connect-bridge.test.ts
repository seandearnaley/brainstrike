import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
  type WorkspaceOpenOrigin,
} from '../workspace-connect/workspace-connect-bridge';

interface MutableWindow {
  workspace?: unknown;
}

afterEach(() => {
  (window as MutableWindow).workspace = undefined;
  resetLogger();
  vi.restoreAllMocks();
});

describe('resolveWorkspaceConnectBridge', () => {
  it('is absent on web', () => {
    expect(resolveWorkspaceConnectBridge()).toBeNull();
  });

  it('resolves a fully-formed bridge', () => {
    (window as MutableWindow).workspace = {
      getDroppedPath: vi.fn(),
      onOpenFolderPicker: vi.fn(),
      onOpenPath: vi.fn(),
    };
    expect(resolveWorkspaceConnectBridge()).not.toBeNull();
  });

  it('treats a partial bridge as ABSENT and says which members are missing', () => {
    configureLogger({ console: false });
    (window as MutableWindow).workspace = { onOpenPath: vi.fn() };
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });
    try {
      expect(resolveWorkspaceConnectBridge()).toBeNull();
    } finally {
      unsubscribe();
    }
    expect(
      records.find((record) => record.scope === 'WorkspaceConnectBridge')?.args
    ).toContainEqual({ missing: ['getDroppedPath', 'onOpenFolderPicker'] });
  });

  it('pins the exact required-method set', () => {
    expect([...WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS]).toEqual([
      'getDroppedPath',
      'onOpenFolderPicker',
      'onOpenPath',
    ]);
  });
});

describe('isWorkspaceOpenPathRequest', () => {
  it('accepts a well-formed request for every declared origin', () => {
    // Falsifier for the origins-completeness bug a reviewer found: this loop
    // fails immediately if a future edit ever shrinks the origin set without
    // updating this test — one assertion per union member, not just 'argv'.
    const origins: readonly WorkspaceOpenOrigin[] = [
      'argv',
      'drop',
      'menu-recent',
      'open-file',
      'second-instance',
    ];
    for (const origin of origins) {
      expect(isWorkspaceOpenPathRequest({ origin, path: '/a/b' })).toBe(true);
    }
  });

  it('rejects every malformed shape rather than coercing it', () => {
    expect(isWorkspaceOpenPathRequest(null)).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: '' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: 42 })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'nope', path: '/a' })).toBe(false);
  });
});
