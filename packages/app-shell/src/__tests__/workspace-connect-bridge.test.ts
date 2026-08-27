import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorkspaceOpenPathRequest,
  resolveWorkspaceConnectBridge,
  stripIpcInvokeEnvelope,
  WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS,
  WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE,
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
      notifyOpenPathReady: vi.fn(),
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
    ).toContainEqual({ missing: ['getDroppedPath', 'notifyOpenPathReady', 'onOpenFolderPicker'] });
  });

  it('pins the exact required-method set', () => {
    expect([...WORKSPACE_CONNECT_BRIDGE_REQUIRED_METHODS]).toEqual([
      'getDroppedPath',
      'notifyOpenPathReady',
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

describe('stripIpcInvokeEnvelope', () => {
  // The ONE shared copy both `use-connect-folder.tsx` and
  // `hooks/use-workspace-bar.ts` consume (PR #2686 review) — pinned here at
  // the export so neither consumer can drift from the other again.
  const refusal = WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE;

  it('strips the plain-Error envelope', () => {
    expect(
      stripIpcInvokeEnvelope(`Error invoking remote method 'fs:addRootByPath': Error: ${refusal}`)
    ).toBe(refusal);
  });

  it('strips a CLASS-named envelope — the shape main actually throws (AccessError)', () => {
    expect(
      stripIpcInvokeEnvelope(
        `Error invoking remote method 'fs:addRootByPath': AccessError: ${refusal}`
      )
    ).toBe(refusal);
  });

  it('strips the envelope alone when no error name follows', () => {
    expect(
      stripIpcInvokeEnvelope(`Error invoking remote method 'fs:addRootByPath': ${refusal}`)
    ).toBe(refusal);
  });

  it('returns a non-enveloped message unchanged', () => {
    expect(stripIpcInvokeEnvelope(refusal)).toBe(refusal);
  });

  it('leaves a NON-Error-suffixed class name in place — display-only contract', () => {
    // Deliberate: an unrecognized class prefix survives stripping, which is
    // exactly why the behavioral refusal match is a SUFFIX match in
    // use-connect-folder.tsx and never equality on this function's output.
    expect(
      stripIpcInvokeEnvelope(
        `Error invoking remote method 'fs:addRootByPath': RefusalFault: ${refusal}`
      )
    ).toBe(`RefusalFault: ${refusal}`);
  });
});
