import { PassThrough, Writable } from 'node:stream';
import {
  BoundaryFailureError,
  fault,
  INTERNAL_FAULT,
  refusal,
  ToolInputError,
} from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  fromBoundaryResponseError,
  isConnectionLoss,
  isUnsentRequest,
  toBoundaryResponseError,
  watchPeerReset,
} from '../src/boundary-wire.js';

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
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'Untyped failure crossed a process boundary',
      expect.objectContaining({ correlationId, error: expect.objectContaining({ message: RAW }) })
    );
  });

  it('sends a typed fault with a correlation id and logs its inner cause there', () => {
    const log = vi.fn();
    const sent = toBoundaryResponseError(
      new BoundaryFailureError(
        fault({
          category: 'internal',
          code: 'host.cleanup-failed',
          message: 'Host cleanup failed.',
        }),
        { cause: new Error(RAW) }
      ),
      log
    );
    expect(sent.code).toBe(ErrorCodes.InternalError);
    const correlationId = (sent.data as { correlationId?: string }).correlationId;
    expect(sent.data).toEqual({
      category: 'internal',
      code: 'host.cleanup-failed',
      correlationId,
      kind: 'fault',
      message: 'Host cleanup failed.',
    });
    expect(JSON.stringify(sent.data)).not.toContain('/Users/');
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'A typed fault crossed a process boundary',
      expect.objectContaining({ cause: expect.objectContaining({ message: RAW }), correlationId })
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

  it('reads a write onto a transport its peer reset as a lost connection, and any other write failure as the logged internal fault (BST-2192)', async () => {
    const connect = (failure?: Error) => {
      const connection = createMessageConnection(
        new StreamMessageReader(new PassThrough()),
        new StreamMessageWriter(new Writable({ write: (_chunk, _encoding, done) => done(failure) }))
      );
      watchPeerReset(connection);
      connection.listen();
      return connection;
    };
    const send = (connection: ReturnType<typeof connect>, params: object) =>
      connection.sendRequest('catalog/read', params).catch((cause: unknown) => cause);
    const log = vi.fn();
    const reset = connect(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const live = connect();
    try {
      const unwritten = await send(reset, {});
      expect(unwritten).toMatchObject({ code: ErrorCodes.MessageWriteError });
      expect(isConnectionLoss(fromBoundaryResponseError(unwritten, log, reset))).toBe(true);
      expect(log).not.toHaveBeenCalled();
      // vscode-jsonrpc rejects params JSON cannot encode with the same code. On a
      // live transport that is a defect to log, not a lost connection.
      const unencodable = await send(live, { size: 1n });
      expect(unencodable).toMatchObject({ code: ErrorCodes.MessageWriteError });
      const read = fromBoundaryResponseError(unencodable, log, live);
      expect((read as BoundaryFailureError).failure).toEqual(INTERNAL_FAULT);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      reset.dispose();
      live.dispose();
    }
  });

  it('takes a peer reset as the cause of only the write it failed, never a later one (BST-2192)', async () => {
    // Every write onto this transport meets the peer's reset; the second request
    // never reaches it, because JSON cannot encode its params.
    const connection = createMessageConnection(
      new StreamMessageReader(new PassThrough()),
      new StreamMessageWriter(
        new Writable({
          write: (_chunk, _encoding, done) =>
            done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
        })
      )
    );
    watchPeerReset(connection);
    connection.listen();
    const log = vi.fn();
    try {
      // Both are admitted before the reset closes the connection.
      const [reset, unencodable] = await Promise.all([
        connection.sendRequest('catalog/read', {}).catch((cause: unknown) => cause),
        connection.sendRequest('catalog/read', { size: 1n }).catch((cause: unknown) => cause),
      ]);
      expect(isConnectionLoss(fromBoundaryResponseError(reset, log, connection))).toBe(true);
      expect(log).not.toHaveBeenCalled();
      expect(unencodable).toMatchObject({ code: ErrorCodes.MessageWriteError });
      const read = fromBoundaryResponseError(unencodable, log, connection);
      expect((read as BoundaryFailureError).failure).toEqual(INTERNAL_FAULT);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      connection.dispose();
    }
  });

  it('reads a request a disposed connection refused to send as unsent, a refusal nothing logs', async () => {
    const connection = createMessageConnection(
      new StreamMessageReader(new PassThrough()),
      new StreamMessageWriter(new PassThrough())
    );
    connection.listen();
    connection.dispose();
    // vscode-jsonrpc throws synchronously, before writing anything.
    const refused = await Promise.resolve()
      .then(() => connection.sendRequest('catalog/read', {}))
      .catch((cause: unknown) => cause);
    const log = vi.fn();
    const read = fromBoundaryResponseError(refused, log);
    expect(isUnsentRequest(read)).toBe(true);
    expect((read as BoundaryFailureError).failure).toEqual({
      category: 'availability',
      code: 'host.connection-closed',
      kind: 'refusal',
      message: 'The agent host connection had closed, so the request was not sent.',
    });
    expect((read as Error).cause).toBe(refused);
    // Across the next boundary it stays a refusal, with nothing logged as a fault.
    expect(toBoundaryResponseError(read, log).data).toEqual((read as BoundaryFailureError).failure);
    expect(log).not.toHaveBeenCalled();
    // A request that was sent and then lost is not unsent: it may have run.
    expect(
      isUnsentRequest(
        fromBoundaryResponseError(
          new ResponseError(ErrorCodes.PendingResponseRejected, 'Pending response rejected'),
          vi.fn()
        )
      )
    ).toBe(false);
  });
});
