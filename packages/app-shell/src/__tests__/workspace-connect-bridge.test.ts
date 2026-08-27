import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
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
  it('accepts a well-formed request', () => {
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: '/a/b' })).toBe(true);
  });

  it('rejects every malformed shape rather than coercing it', () => {
    expect(isWorkspaceOpenPathRequest(null)).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: '' })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'argv', path: 42 })).toBe(false);
    expect(isWorkspaceOpenPathRequest({ origin: 'nope', path: '/a' })).toBe(false);
  });
});
