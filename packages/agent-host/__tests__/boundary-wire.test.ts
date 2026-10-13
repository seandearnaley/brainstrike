import {
  BoundaryFailureError,
  INTERNAL_FAULT,
  refusal,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import { fromBoundaryResponseError, toBoundaryResponseError } from '../src/boundary-wire.js';

const RAW = 'ENOENT: no such file or directory, lstat /Users/someone/project/missing.ts';

describe('boundary failures on a JSON-RPC connection', () => {
  it('sends a typed refusal as the response data and reads it back unchanged', () => {
    const failure = refusal({
      category: 'conflict',
      code: 'workspace.folder-removed',
      message: 'The folder "bravo" was removed from the workspace.',
      remedy: 'Add it back, or choose another folder for this thread.',
    });
    const log = vi.fn();
    const sent = toBoundaryResponseError(new BoundaryFailureError(failure), log);
    expect(sent.message).toBe(failure.message);
    expect(sent.data).toEqual(failure);
    // As the peer receives it: the wire carries only the JSON form.
    const received = new ResponseError(
      sent.code,
      sent.message,
      JSON.parse(JSON.stringify(sent.data))
    );
    const read = fromBoundaryResponseError(received, log);
    expect(read).toBeInstanceOf(BoundaryFailureError);
    expect((read as BoundaryFailureError).failure).toEqual(failure);
    expect(log).not.toHaveBeenCalled();
  });

  it('sends an untyped error as the fixed internal fault and logs it under its correlation id', () => {
    const log = vi.fn();
    const sent = toBoundaryResponseError(new Error(RAW), log);
    expect(sent.code).toBe(ErrorCodes.InternalError);
    expect(sent.message).toBe(INTERNAL_FAULT.message);
    expect(JSON.stringify(sent.data)).not.toContain('/Users/');
    const correlationId = (sent.data as { correlationId?: string }).correlationId;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Untyped failure crossed a process boundary',
      expect.objectContaining({ correlationId, error: expect.objectContaining({ message: RAW }) })
    );
  });

  it('sends a tool input error as a refusal the model may read', () => {
    const sent = toBoundaryResponseError(
      new ToolInputError('Pass a path inside the folder.'),
      vi.fn()
    );
    expect(sent.data).toEqual({
      category: 'input',
      code: 'tool.input-invalid',
      kind: 'refusal',
      message: 'Pass a path inside the folder.',
    });
  });

  it('reads a response without valid data as the internal fault and logs what arrived', () => {
    const log = vi.fn();
    for (const arrived of [
      new ResponseError(ErrorCodes.InternalError, RAW),
      new ResponseError(-32_001, RAW, { kind: 'refusal', message: RAW }),
    ]) {
      const read = fromBoundaryResponseError(arrived, log);
      expect((read as BoundaryFailureError).failure).toEqual(INTERNAL_FAULT);
      expect((read as Error).message).not.toContain('/Users/');
      expect((read as Error).cause).toBe(arrived);
    }
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('reads a request the closed connection never answered as a lost connection', () => {
    const read = fromBoundaryResponseError(
      new ResponseError(
        ErrorCodes.PendingResponseRejected,
        'Pending response rejected since connection got disposed'
      ),
      vi.fn()
    );
    expect((read as BoundaryFailureError).failure).toEqual({
      category: 'availability',
      code: 'host.connection-lost',
      kind: 'fault',
      message: 'The connection closed before the request was answered.',
    });
  });
});
