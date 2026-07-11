import type { McpServer } from '../mcp-loader';
import { createHttpClient } from './http-client';
import type { McpClient } from './types';

/**
 * Compatibility entry for callers that still import the legacy SSE-specific
 * factory. The canonical adapter owns both explicit HTTP transports.
 */
export function createSseClient(server: Extract<McpServer, { transport: 'sse' }>): McpClient {
  return createHttpClient(server);
}
