import { describe, expect, it } from 'vitest';
import {
  BoundaryFailureError,
  decodeBoundaryFailure,
  fault,
  INTERNAL_FAULT,
  isStateStoreReadOnly,
  processLost,
  refusal,
  STATE_STORE_READ_ONLY_CODE,
} from '../boundary-failure';

describe('boundary failure taxonomy', () => {
  it('decodes a typed refusal exactly as it was sent', () => {
    const sent = refusal({
      category: 'conflict',
      code: 'workspace.folder-removed',
      message: 'This thread’s folder was removed.',
      remedy: 'Choose another folder from the folder chip.',
    });
    expect(decodeBoundaryFailure(JSON.parse(JSON.stringify(sent)))).toEqual({
      failure: sent,
      valid: true,
    });
  });

  it('turns missing or invalid data into the fixed internal fault, never its raw text', () => {
    for (const wire of [
      undefined,
      null,
      'ENOENT: no such file or directory, lstat /Users/someone/secret.txt',
      { message: 'raw provider body {"error":"quota"}' },
      { category: 'input', code: 'Not Namespaced', kind: 'refusal', message: 'x' },
      { category: 'input', code: 'tool.input', kind: 'refusal', message: 'x', stack: 'at …' },
    ]) {
      expect(decodeBoundaryFailure(wire)).toEqual({ failure: INTERNAL_FAULT, valid: false });
    }
  });

  it('describes a lost child process as an availability fault with its exit facts', () => {
    expect(processLost({ child: 'agent-host', exitCode: 9 })).toEqual({
      category: 'availability',
      code: 'process.lost',
      kind: 'fault',
      message: 'The agent host stopped unexpectedly.',
      process: { child: 'agent-host', exitCode: 9 },
    });
  });

  it('carries its failure through a thrown error, keeping the inner cause', () => {
    const cause = new Error('raw driver text');
    const thrown = new BoundaryFailureError(
      refusal({ category: 'input', code: 'model.not-enabled', message: 'Enable the model first.' }),
      { cause }
    );
    expect(thrown.message).toBe('Enable the model first.');
    expect(thrown.cause).toBe(cause);
    expect(thrown.failure.code).toBe('model.not-enabled');
  });

  it('recognises only the state store’s read-only refusal as one (BST-2144)', () => {
    const readOnly = { category: 'availability', code: STATE_STORE_READ_ONLY_CODE } as const;
    const message = 'The conversation store is read-only.';
    expect(isStateStoreReadOnly(new BoundaryFailureError(refusal({ ...readOnly, message })))).toBe(
      true
    );
    expect(isStateStoreReadOnly(new BoundaryFailureError(fault({ ...readOnly, message })))).toBe(
      false
    );
    expect(
      isStateStoreReadOnly(
        new BoundaryFailureError(
          refusal({ category: 'availability', code: 'thread.read-only', message })
        )
      )
    ).toBe(false);
    expect(isStateStoreReadOnly(new Error(message))).toBe(false);
  });
});
