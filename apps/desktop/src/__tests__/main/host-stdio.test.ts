import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformMessagePort } from '../../agent-host-platform/connection';
import { openHostStdio } from '../../host-stdio';

/** Main's end and the host's end of one host process's stdin and stdout. */
function pipe() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const opened = new Map<string, PlatformMessagePort>();
  const hostMessages: unknown[] = [];
  const mainMessages: unknown[] = [];
  const invalid = vi.fn();
  const host = openHostStdio(stdin, stdout, {
    invalid,
    message: (message) => hostMessages.push(message),
    opened: (channel, port) => opened.set(channel, port),
  });
  const main = openHostStdio(stdout, stdin, {
    invalid,
    message: (message) => mainMessages.push(message),
  });
  return { host, hostMessages, invalid, main, mainMessages, opened, stdin, stdout };
}
function received(port: PlatformMessagePort): unknown[] {
  const messages: unknown[] = [];
  port.on('message', (event) => messages.push(event.data));
  port.start();
  return messages;
}

describe("the host's stdio", () => {
  it('writes one JSON-RPC notification per line', async () => {
    const { main, stdin } = pipe();
    const lines: string[] = [];
    stdin.on('data', (chunk: Buffer) => lines.push(...chunk.toString('utf8').split('\n')));
    await main.message({ method: 'clear-content' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      method: 'host/message',
      params: { method: 'clear-content' },
    });
  });

  it('carries each channel separately both ways, holding messages until its reader starts', async () => {
    const { main, opened } = pipe();
    const platform = main.open('platform');
    const client = main.open('client-1');
    platform.postMessage({ id: 1, jsonrpc: '2.0', method: 'platform/ready' });
    client.postMessage({ id: 1, jsonrpc: '2.0', method: 'initialize' });
    await vi.waitFor(() => expect([...opened.keys()]).toEqual(['platform', 'client-1']));
    const hostPlatform = opened.get('platform');
    const hostClient = opened.get('client-1');
    if (!(hostPlatform && hostClient)) {
      throw new Error('The host did not receive both channels');
    }
    const atPlatform = received(hostPlatform);
    const atClient = received(hostClient);
    await vi.waitFor(() => expect(atPlatform).toHaveLength(1));
    expect(atPlatform).toEqual([{ id: 1, jsonrpc: '2.0', method: 'platform/ready' }]);
    expect(atClient).toEqual([{ id: 1, jsonrpc: '2.0', method: 'initialize' }]);
    const answers = received(client);
    hostClient.postMessage({ id: 1, jsonrpc: '2.0', result: null });
    await vi.waitFor(() => expect(answers).toEqual([{ id: 1, jsonrpc: '2.0', result: null }]));
  });

  it('closes a channel at the other end when one end closes it, and leaves the others open', async () => {
    const { main, opened } = pipe();
    const first = main.open('client-1');
    const second = main.open('client-2');
    await vi.waitFor(() => expect(opened.size).toBe(2));
    const closed = vi.fn();
    opened.get('client-1')?.on('close', closed);
    first.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(() => first.postMessage({})).toThrow('closed');
    const atSecond = opened.get('client-2');
    const messages = atSecond ? received(atSecond) : [];
    second.postMessage({ still: 'open' });
    await vi.waitFor(() => expect(messages).toEqual([{ still: 'open' }]));
  });

  it("ends at stdin's end: the host sees every channel close and its input end", async () => {
    const { host, main, opened } = pipe();
    main.open('main');
    await vi.waitFor(() => expect(opened.size).toBe(1));
    const closed = vi.fn();
    opened.get('main')?.on('close', closed);
    main.end();
    await host.ended;
    expect(closed).toHaveBeenCalledOnce();
  });

  it('reports a line that is not this protocol and stops reading', async () => {
    const { hostMessages, invalid, stdin } = pipe();
    stdin.write('a log line that is not JSON\n');
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'host/message', params: {} })}\n`);
    await vi.waitFor(() => expect(invalid).toHaveBeenCalledOnce());
    expect(String(invalid.mock.calls[0]?.[0])).toContain('a log line that is not JSON');
    expect(hostMessages).toEqual([]);
  });
});
