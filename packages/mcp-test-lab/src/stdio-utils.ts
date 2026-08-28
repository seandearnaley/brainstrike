import type { JSONRPCMessage } from '@modelcontextprotocol/client';

export function requestMethodFromMessage(message: JSONRPCMessage): string | undefined {
  return 'method' in message && typeof message.method === 'string' ? message.method : undefined;
}

export function requestIdKey(message: JSONRPCMessage): string | undefined {
  if (!('method' in message && 'id' in message) || message.id === null) {
    return;
  }
  return `${typeof message.id}:${String(message.id)}`;
}

export function responseIdKey(message: JSONRPCMessage): string | undefined {
  if ('method' in message || !('id' in message) || message.id === null) {
    return;
  }
  return `${typeof message.id}:${String(message.id)}`;
}

export function stdioChunkByteLength(chunk: unknown): number {
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk);
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }
  return Buffer.byteLength(String(chunk));
}
