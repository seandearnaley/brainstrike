import { serialize } from 'node:v8';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMessageConnection,
  type MessageConnection,
  PortMessageReader,
  PortMessageWriter,
  ResponseError,
} from 'vscode-jsonrpc/node';
import { serveQueryHost } from '../host-core.js';
import type { SqliteGrepRows } from '../protocol.js';
import { SqliteRuntimeRefusedError } from '../runtime-refusal.js';

const { grepMock } = vi.hoisted(() => ({ grepMock: vi.fn<() => SqliteGrepRows>() }));
vi.mock('../sandbox.js', () => ({
  SqliteSandbox: class {
    close(): void {}
    grep(): SqliteGrepRows {
      return grepMock();
    }
  },
}));

const identity = { storeId: 'a'.repeat(64) };
const grep = {
  caseSensitive: false,
  isRegex: false,
  maxRows: 1,
  pattern: 'needle',
  rootIds: ['root'],
};
const authority = {
  authorityEpoch: 'b'.repeat(64),
  authorityRevision: 7,
  dbPath: '/owned.sqlite',
  fileBindings: [],
  rootIds: [],
  scopes: [],
  storeId: 'a'.repeat(64),
};

let client: MessageConnection;
let host: MessageConnection;
let channel: MessageChannel;
beforeEach(() => {
  grepMock.mockReset();
  channel = new MessageChannel();
  host = createMessageConnection(
    new PortMessageReader(channel.port1),
    new PortMessageWriter(channel.port1)
  );
  serveQueryHost(host);
  host.listen();
  client = createMessageConnection(
    new PortMessageReader(channel.port2),
    new PortMessageWriter(channel.port2)
  );
  client.listen();
});
afterEach(() => {
  client.dispose();
  host.dispose();
  channel.port1.close();
});

/** The refusal a request was answered with. */
async function refusal(method: string, params: unknown): Promise<ResponseError<unknown>> {
  const error: unknown = await client.sendRequest(method, params).then(
    () => undefined,
    (cause: unknown) => cause
  );
  if (!(error instanceof ResponseError)) {
    throw new Error(`${method} was not refused.`);
  }
  return error;
}

describe('query process boundary', () => {
  it('preserves a runtime refusal through the process response boundary', async () => {
    await client.sendRequest('open', { databasePath: 'owned.sqlite' });
    const engine = new SqliteRuntimeRefusedError('Engine memory accounting is unavailable.');
    grepMock.mockImplementationOnce(() => {
      throw engine;
    });
    const error = await refusal('grep', grep);
    expect(error.message).toBe(engine.message);
    expect(error.data).toEqual({ kind: 'engine', name: 'SqliteRuntimeRefusedError' });
    expect(engine.code).toBe('sqlite_runtime_refused');
  });

  it('refuses native coverage in a grep owner', async () => {
    await client.sendRequest('open', { databasePath: 'owned.sqlite' });
    const error = await refusal('nativeCoverage', {
      requests: [{ scope: { kind: 'workspace', rootId: 'root' } }],
    });
    expect(error.data).toMatchObject({
      fault: { message: expect.stringContaining('coverage-only owner') },
      kind: 'coverage',
    });
  });

  it('refuses grep in a trusted coverage owner', async () => {
    await client.sendRequest('openNativeCoverage', { authority });
    const error = await refusal('grep', grep);
    expect(error.message).toBe('SQLite query process has not been initialized.');
    expect(grepMock).not.toHaveBeenCalled();
  });

  it('answers params that do not decode without opening anything', async () => {
    const error = await refusal('open', { databasePath: 'owned.sqlite', sql: 'SELECT 1' });
    expect(error.data).toBeUndefined();
    await client.sendRequest('open', { databasePath: 'owned.sqlite' });
  });

  it('refuses a reply whose envelope exceeds the budget and retains grep admission', async () => {
    await client.sendRequest('open', { databasePath: 'owned.sqlite' });
    const sized = (length: number) => ({
      columns: ['x'.repeat(length)],
      identity,
      matchedChunks: 0,
      rows: [],
      truncated: false,
    });
    // The result alone sits exactly at the budget; only the envelope crosses it.
    const result = sized(2 * 1024 * 1024 - serialize(sized(1024 * 1024)).byteLength);
    expect(serialize(result).byteLength).toBe(1024 * 1024);
    grepMock.mockReturnValueOnce(result);
    const error = await refusal('grep', grep);
    expect(error.message).toContain('process-message budget');
    expect(error.data).toEqual({ kind: 'engine', name: 'RangeError' });
    const small = {
      columns: ['id'],
      identity,
      matchedChunks: 1,
      rows: [[1n, new Uint8Array([2])]],
      truncated: false,
    };
    grepMock.mockReturnValueOnce(small);
    expect(await client.sendRequest('grep', grep)).toEqual(small);
  });
});
