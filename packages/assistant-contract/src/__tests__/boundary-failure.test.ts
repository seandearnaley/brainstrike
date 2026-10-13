import { describe, expect, it } from 'vitest';
import {
  BoundaryFailureError,
  decodeBoundaryFailure,
  INTERNAL_FAULT,
  processLost,
  refusal,
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
});
