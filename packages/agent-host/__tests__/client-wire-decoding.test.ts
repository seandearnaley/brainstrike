import { PassThrough } from 'node:stream';
import { BoundaryFailureError, INTERNAL_FAULT } from '@brainstrike/assistant-contract';
import type { HostRecord } from '@brainstrike/host-lease';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { authenticateHostClient } from '../src/client-connection.js';
import { stdioConnection } from '../src/transports.js';

// Real JSON-RPC frames, without a host process or access to a user's profile.
test('the client distinguishes owned parser failures from ordinary invalid wire data', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = stdioConnection(input, output);
  const record: HostRecord = {
    endpoint: '/tmp/unused-wire-decoder-fixture',
    hostVersion: '0.1.0',
    pid: 1,
    protocolVersion: 11,
    start: 'fixture',
    token: 'a'.repeat(64),
  };
  server.onRequest('initialize', () => ({
    hostVersion: record.hostVersion,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
    start: record.start,
  }));
  let status: unknown = {};
  server.onRequest('mcp/status/read', () => status);
  server.onRequest('thread/list', () => ({}));
  server.listen();
  const closed = Promise.withResolvers<void>();
  const client = await authenticateHostClient(
    stdioConnection(output, input),
    record,
    async () => {
      server.dispose();
      input.destroy();
      output.destroy();
      closed.resolve();
    },
    closed.promise
  );
  try {
    // An inner schema error is an owned decoder exception, not a top-level refusal.
    await expect(client.request('mcp/status/read', {})).rejects.toBeInstanceOf(Schema.SchemaError);
    status = { revision: 0, servers: [] };
    await expect(client.request('mcp/status/read', {})).resolves.toEqual(status);
    const invalid = client.request('thread/list', {});
    await expect(invalid).rejects.toBeInstanceOf(BoundaryFailureError);
    await expect(invalid).rejects.toMatchObject({
      cause: expect.any(Schema.SchemaError),
      failure: { ...INTERNAL_FAULT, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
  } finally {
    await client.close();
  }
});
