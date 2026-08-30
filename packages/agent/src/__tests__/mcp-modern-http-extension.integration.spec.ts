import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { ExplicitHttpMcpClient } from '../mcp/explicit-http-client';
import {
  createDeferredTestExtension,
  TEST_EXTENSION_ID,
  TEST_EXTENSION_SETTINGS,
} from './fixtures/mcp-client-extension-registry';

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanupTasks.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Pinned-modern HTTP MCP test cleanup failed');
  }
});

it('projects registered extensions onto pinned-modern Streamable HTTP requests', async () => {
  const handler = createMcpHandler(
    () => new McpServer({ name: 'modern-capabilities-server', version: '1.0.0' }),
    { legacy: 'reject' }
  );
  cleanupTasks.push(() => handler.close());
  const extension = createDeferredTestExtension();
  const requests: unknown[] = [];
  const client = new ExplicitHttpMcpClient({
    extensionRegistry: extension.registry,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(await request.clone().json());
      return handler.fetch(request);
    },
    name: 'pinned-modern-capabilities-canary',
    protocol: '2026-07-28',
    transport: 'streamable-http',
    url: 'http://mcp-modern.invalid/mcp',
  });
  cleanupTasks.push(() => client.close());
  extension.register();

  await client.connect();

  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { [TEST_EXTENSION_ID]: TEST_EXTENSION_SETTINGS },
        },
      },
    },
  });
});
