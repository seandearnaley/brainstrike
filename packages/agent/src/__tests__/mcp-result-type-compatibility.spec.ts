import { parseJSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultAbsentMcpResultType,
  installMcpResultTypeCompatibility,
} from '../mcp/result-type-compatibility';

const completedWithoutDiscriminator = () =>
  parseJSONRPCMessage({
    id: 1,
    jsonrpc: '2.0',
    result: { content: [{ text: 'done', type: 'text' }] },
  });

describe('MCP resultType compatibility', () => {
  it('maps an absent modern resultType to complete without mutating the wire message', () => {
    const message = completedWithoutDiscriminator();

    expect(defaultAbsentMcpResultType(message, 'modern')).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: {
        content: [{ text: 'done', type: 'text' }],
        resultType: 'complete',
      },
    });
    expect(message).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: { content: [{ text: 'done', type: 'text' }] },
    });
  });

  it.each(['complete', 'input_required', 'vendor-result'])(
    'preserves an explicit resultType of %s',
    (resultType) => {
      const message = parseJSONRPCMessage({
        id: 1,
        jsonrpc: '2.0',
        result: { resultType },
      });

      expect(defaultAbsentMcpResultType(message, 'modern')).toBe(message);
    }
  );

  it('does not rewrite legacy results, errors, or notifications', () => {
    const legacy = completedWithoutDiscriminator();
    const error = parseJSONRPCMessage({
      error: { code: -32_000, message: 'failed' },
      id: 1,
      jsonrpc: '2.0',
    });
    const notification = parseJSONRPCMessage({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progress: 1, progressToken: 'token' },
    });

    expect(defaultAbsentMcpResultType(legacy, 'legacy')).toBe(legacy);
    expect(defaultAbsentMcpResultType(error, 'modern')).toBe(error);
    expect(defaultAbsentMcpResultType(notification, 'modern')).toBe(notification);
  });

  it('uses the negotiated modern era when transport metadata is absent', async () => {
    let negotiatedEra: 'legacy' | 'modern' | undefined;
    const start = vi.fn(async () => undefined);
    const transport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start,
    } satisfies Transport;
    const received: unknown[] = [];
    const installed = installMcpResultTypeCompatibility(transport, 'auto', () => negotiatedEra);
    installed.onmessage = (message) => received.push(message);
    negotiatedEra = 'modern';

    await installed.start();
    await transport.onmessage?.(completedWithoutDiscriminator());

    expect(received).toEqual([
      {
        id: 1,
        jsonrpc: '2.0',
        result: {
          content: [{ text: 'done', type: 'text' }],
          resultType: 'complete',
        },
      },
    ]);
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    { expected: 'complete', negotiatedEra: undefined, protocol: '2026-07-28' as const },
    { expected: undefined, negotiatedEra: undefined, protocol: 'auto' as const },
    { expected: undefined, negotiatedEra: 'legacy' as const, protocol: 'auto' as const },
  ])(
    'resolves $protocol with negotiated era $negotiatedEra without guessing',
    async ({ expected, negotiatedEra, protocol }) => {
      const transport = {
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
      } satisfies Transport;
      let received: unknown;
      const installed = installMcpResultTypeCompatibility(transport, protocol, () => negotiatedEra);
      installed.onmessage = (message) => {
        received = message;
      };

      await installed.start();
      await transport.onmessage?.(completedWithoutDiscriminator());

      expect(received).toMatchObject({
        result: expected === undefined ? {} : { resultType: expected },
      });
    }
  );

  it('preserves an existing onmessage accessor and rejects conflicting reinstall', async () => {
    let assignedHandler: Transport['onmessage'];
    const transport = {
      close: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
    } satisfies Transport;
    const getHandler = vi.fn(() => assignedHandler);
    const setHandler = vi.fn((handler: Transport['onmessage']) => {
      assignedHandler = handler;
    });
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      enumerable: true,
      get: getHandler,
      set: setHandler,
    });
    const descriptor = Object.getOwnPropertyDescriptor(transport, 'onmessage');
    const getNegotiatedEra = () => 'modern' as const;
    const installed = installMcpResultTypeCompatibility(transport, 'auto', getNegotiatedEra);

    expect(installMcpResultTypeCompatibility(installed, 'auto', getNegotiatedEra)).toBe(installed);
    expect(() => installMcpResultTypeCompatibility(installed, 'legacy', getNegotiatedEra)).toThrow(
      'already installed for protocol auto'
    );
    expect(Object.getOwnPropertyDescriptor(transport, 'onmessage')).toMatchObject({
      configurable: descriptor?.configurable,
      enumerable: descriptor?.enumerable,
    });

    const received: unknown[] = [];
    installed.onmessage = (message) => received.push(message);
    await installed.start();
    await transport.onmessage?.(completedWithoutDiscriminator());

    expect(getHandler).toHaveBeenCalled();
    expect(setHandler).toHaveBeenCalledOnce();
    expect(received).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ resultType: 'complete' }) }),
    ]);
    expect(Object.getOwnPropertyDescriptor(transport, 'onmessage')).toMatchObject({
      configurable: descriptor?.configurable,
      enumerable: descriptor?.enumerable,
    });
  });
});
