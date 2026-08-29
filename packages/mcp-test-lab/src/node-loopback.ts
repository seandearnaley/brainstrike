import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { isMcpLabCorrelationId } from './faults.js';

export function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('MCP lab listener has no TCP address'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

export function toCorrelatedNodeRequest(
  request: IncomingMessage,
  correlationId: string
): NodeIncomingMessageLike {
  return {
    [Symbol.asyncIterator]() {
      return request[Symbol.asyncIterator]();
    },
    headers: { ...request.headers, 'x-mcp-lab-correlation-id': correlationId },
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.url === undefined ? {} : { url: request.url }),
  };
}

export function correlationIdForNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  nextCorrelation: () => string
): string | undefined {
  const supplied = request.headers['x-mcp-lab-correlation-id'];
  if (supplied === undefined) {
    return nextCorrelation();
  }
  if (!isMcpLabCorrelationId(supplied)) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'invalid_correlation_id' }));
    return;
  }
  return supplied;
}

export function closeLoopbackServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function writeNodeResponse(response: ServerResponse, source: Response): Promise<void> {
  response.writeHead(source.status, Object.fromEntries(source.headers));
  response.end(Buffer.from(await source.arrayBuffer()));
}
