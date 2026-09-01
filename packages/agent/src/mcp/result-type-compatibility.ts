import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import type { McpProtocol } from './config.js';

type McpMessageHandler = NonNullable<Transport['onmessage']>;
type McpMessageExtra = Parameters<McpMessageHandler>[1];
type McpProtocolEra = 'legacy' | 'modern';
type NegotiatedEraResolver = () => McpProtocolEra | undefined;

interface InstalledCompatibility {
  getNegotiatedEra: NegotiatedEraResolver;
  protocol: McpProtocol;
}

const installedTransports = new WeakMap<Transport, InstalledCompatibility>();
const unresolvedNegotiatedEra: NegotiatedEraResolver = () => undefined;

function createMessageHandlerBinding(transport: Transport): {
  configurable: boolean;
  enumerable: boolean;
  read: () => Transport['onmessage'];
  write: (handler: Transport['onmessage']) => void;
} {
  const descriptor = Object.getOwnPropertyDescriptor(transport, 'onmessage');
  if (descriptor && !descriptor.configurable) {
    throw new Error('MCP resultType compatibility requires configurable transport onmessage');
  }
  if (descriptor?.get || descriptor?.set) {
    if (!descriptor.set) {
      throw new Error('MCP resultType compatibility requires writable transport onmessage');
    }
    return {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      read: descriptor.get
        ? () => descriptor.get?.call(transport) as Transport['onmessage']
        : () => undefined,
      write: (handler) => descriptor.set?.call(transport, handler),
    };
  }
  let handler = descriptor?.value as Transport['onmessage'];
  return {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    read: () => handler,
    write: (nextHandler) => {
      handler = nextHandler;
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function messageEra(
  protocol: McpProtocol,
  getNegotiatedEra: NegotiatedEraResolver,
  extra: McpMessageExtra
): McpProtocolEra {
  if (protocol === '2026-07-28') {
    return 'modern';
  }
  if (protocol === 'legacy') {
    return 'legacy';
  }
  return getNegotiatedEra() ?? (extra?.classification?.era === 'modern' ? 'modern' : 'legacy');
}

/**
 * SEP-2322's compatibility rule treats an absent resultType as complete.
 * @modelcontextprotocol/client 2.0.0 rejects that wire shape for 2026-07-28,
 * so normalize only the absent discriminator before the SDK codec sees it.
 */
export function defaultAbsentMcpResultType(
  message: JSONRPCMessage,
  era: McpProtocolEra
): JSONRPCMessage {
  if (era !== 'modern' || !('result' in message)) {
    return message;
  }
  const result = message.result;
  if (!isPlainRecord(result) || Object.hasOwn(result, 'resultType')) {
    return message;
  }
  return { ...message, result: { ...result, resultType: 'complete' } };
}

export function installMcpResultTypeCompatibility<OwnedTransport extends Transport>(
  transport: OwnedTransport,
  protocol: McpProtocol,
  getNegotiatedEra: NegotiatedEraResolver = unresolvedNegotiatedEra
): OwnedTransport {
  const existing = installedTransports.get(transport);
  if (existing) {
    if (existing.protocol !== protocol || existing.getNegotiatedEra !== getNegotiatedEra) {
      throw new Error(
        `MCP resultType compatibility is already installed for protocol ${existing.protocol}`
      );
    }
    return transport;
  }
  const binding = createMessageHandlerBinding(transport);
  installedTransports.set(transport, { getNegotiatedEra, protocol });
  const rawByWrapped = new WeakMap<McpMessageHandler, McpMessageHandler>();
  const wrappedByRaw = new WeakMap<McpMessageHandler, McpMessageHandler>();
  const wrap = (handler: McpMessageHandler): McpMessageHandler => {
    const existingWrapper = wrappedByRaw.get(handler);
    if (existingWrapper) {
      return existingWrapper;
    }
    const wrappedHandler: McpMessageHandler = (message, extra) =>
      handler(
        defaultAbsentMcpResultType(message, messageEra(protocol, getNegotiatedEra, extra)),
        extra
      );
    rawByWrapped.set(wrappedHandler, handler);
    wrappedByRaw.set(handler, wrappedHandler);
    return wrappedHandler;
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: binding.configurable,
    enumerable: binding.enumerable,
    get: () => {
      const handler = binding.read();
      return handler ? wrap(handler) : undefined;
    },
    set: (handler: Transport['onmessage']) => {
      binding.write(handler ? (rawByWrapped.get(handler) ?? handler) : undefined);
    },
  });
  return transport;
}
