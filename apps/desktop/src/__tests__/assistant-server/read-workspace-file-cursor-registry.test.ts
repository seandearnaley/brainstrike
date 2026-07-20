import { describe, expect, it } from 'vitest';
import {
  ReadWorkspaceFileCursorRegistry,
  type ReadWorkspaceFileCursorScope,
  type ReadWorkspaceFileCursorState,
} from '../../assistant-server/read-workspace-file-cursor-registry';

const HANDLE = 'rfh_abcdefghijklmnopqrstuv';
const SCOPE: ReadWorkspaceFileCursorScope = {
  resourceId: 'workspace-a',
  threadId: 'thread-a',
};
const STATE: ReadWorkspaceFileCursorState = {
  column: 4,
  endLine: 80,
  line: 12,
  mtimeMs: 1234,
  path: '/src/main.ts',
  requestedEndLine: 80,
  requestedStartLine: 3,
  rootId: 'root-a',
  size: 4096,
};

describe('ReadWorkspaceFileCursorRegistry', () => {
  it('keeps authoritative continuation identity local behind a short handle', () => {
    const registry = new ReadWorkspaceFileCursorRegistry({
      createHandle: () => HANDLE,
    });

    expect(registry.issue(SCOPE, STATE)).toBe(HANDLE);
    expect(registry.resolve(HANDLE, SCOPE)).toEqual(STATE);
    expect(HANDLE).not.toContain(STATE.path);
    registry.release(HANDLE, SCOPE);
    expect(() => registry.resolve(HANDLE, SCOPE)).toThrow(/unknown or no longer available/i);
    expect(registry.issue(SCOPE, STATE)).toBe(HANDLE);
  });

  it('rejects cross-thread and one-character-mutated handles', () => {
    const registry = new ReadWorkspaceFileCursorRegistry({
      createHandle: () => HANDLE,
    });
    registry.issue(SCOPE, STATE);

    expect(() => registry.resolve(HANDLE, { ...SCOPE, threadId: 'thread-b' })).toThrow(
      /belongs to another assistant thread/i
    );
    expect(() => registry.resolve(`${HANDLE.slice(0, -1)}w`, SCOPE)).toThrow(
      /unknown or no longer available/i
    );
  });

  it('fails expired and factory-reset-cleared handles visibly', () => {
    let now = 100;
    const registry = new ReadWorkspaceFileCursorRegistry({
      createHandle: () => HANDLE,
      now: () => now,
      ttlMs: 50,
    });
    registry.issue(SCOPE, STATE);

    now = 150;
    expect(() => registry.resolve(HANDLE, SCOPE)).toThrow(/has expired/i);

    now = 200;
    registry.issue(SCOPE, STATE);
    registry.clear();
    expect(() => registry.resolve(HANDLE, SCOPE)).toThrow(/unknown or no longer available/i);
  });
});
