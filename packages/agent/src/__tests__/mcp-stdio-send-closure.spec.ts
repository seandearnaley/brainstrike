import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { installMcpStdioSendClosure } from '../mcp/stdio-send-closure';

/**
 * BST-1600 contract: terminal closure settles the writes the SDK's stdio
 * `send()` can no longer settle itself. Nothing here may swallow a failure —
 * a severed write rejects with the closure cause, it never resolves quietly.
 */
const message: JSONRPCMessage = { id: 1, jsonrpc: '2.0', method: 'ping' };

type SendOptions = Parameters<Transport['send']>[1];

interface StubTransport extends Transport {
  readonly options: SendOptions[];
  readonly sent: JSONRPCMessage[];
  settle(): void;
}

function stubTransport(): StubTransport {
  const sent: JSONRPCMessage[] = [];
  const options: SendOptions[] = [];
  const pending: Array<() => void> = [];
  return {
    async close() {
      // no-op
    },
    options,
    async send(outbound: JSONRPCMessage, sendOptions?: SendOptions) {
      sent.push(outbound);
      options.push(sendOptions);
      // Models the SDK's stdio send: it resolves only on the pipe's `'drain'`,
      // which a dead child never emits.
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    },
    sent,
    settle() {
      for (const resolve of pending.splice(0)) {
        resolve();
      }
    },
    async start() {
      // no-op
    },
  };
}

describe('installMcpStdioSendClosure', () => {
  it('passes messages through and resolves when the underlying send drains', async () => {
    const transport = stubTransport();
    installMcpStdioSendClosure(transport);

    const sending = transport.send(message);
    expect(transport.sent).toEqual([message]);
    transport.settle();

    await expect(sending).resolves.toBeUndefined();
  });

  it('rejects an in-flight send that the closed pipe can never drain', async () => {
    const transport = stubTransport();
    const closure = installMcpStdioSendClosure(transport);
    const sending = transport.send(message);

    closure.close(new Error('pipe gone'));

    await expect(sending).rejects.toThrow('pipe gone');
  });

  it('keeps the first cause and rejects every later send with it', async () => {
    const transport = stubTransport();
    const closure = installMcpStdioSendClosure(transport);

    closure.close(new Error('first cause'));
    closure.close(new Error('second cause'));

    await expect(transport.send(message)).rejects.toThrow('first cause');
    // A send refused by the closure never reaches the dead pipe.
    expect(transport.sent).toEqual([]);
  });

  it('forwards send options to the wrapped transport', async () => {
    const transport = stubTransport();
    installMcpStdioSendClosure(transport);

    const sending = transport.send(message, { relatedRequestId: 7 });
    transport.settle();
    await sending;

    expect(transport.options).toEqual([{ relatedRequestId: 7 }]);
  });
});
