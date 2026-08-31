import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpLabFixture } from './scenario.js';

function createBrainstrikeEchoReferenceServer(): McpServer {
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.object({ text: z.string() });
  server.registerTool(
    'echo',
    {
      description: 'Echo a string through the official MCP TypeScript SDK v2 server.',
      inputSchema: echoSchema,
      outputSchema: echoSchema,
    },
    async ({ text }) => ({
      content: [{ text, type: 'text' }],
      structuredContent: { text },
    })
  );
  return server;
}

/**
 * Representative modern profile copied from the official SDK v2 everything
 * server at the exact source recorded by MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE.
 * Keep the names, capability declarations, and literal responses aligned with
 * that source; this deliberately stays bounded instead of vendoring its full
 * process-global conformance fixture.
 */
function createOfficialEverythingReferenceServer(): McpServer {
  const server = new McpServer(
    { name: 'mcp-conformance-test-server', version: '1.0.0' },
    {
      capabilities: {
        completions: {},
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
      },
    }
  );

  server.registerTool(
    'test_simple_text',
    { description: 'Tests simple text content response' },
    async () => ({
      content: [{ text: 'This is a simple text response for testing.', type: 'text' }],
    })
  );
  server.registerResource(
    'static-text',
    'test://static-text',
    {
      description: 'A static text resource for testing',
      mimeType: 'text/plain',
      title: 'Static Text Resource',
    },
    async () => ({
      contents: [
        {
          mimeType: 'text/plain',
          text: 'This is the content of the static text resource.',
          uri: 'test://static-text',
        },
      ],
    })
  );
  server.registerPrompt(
    'test_simple_prompt',
    {
      description: 'A simple prompt without arguments',
      title: 'Simple Test Prompt',
    },
    async () => ({
      messages: [
        {
          content: { text: 'This is a simple prompt for testing.', type: 'text' },
          role: 'user',
        },
      ],
    })
  );
  server.server.setRequestHandler('completion/complete', async () => ({
    completion: { hasMore: false, total: 0, values: [] },
  }));
  server.server.setRequestHandler('resources/subscribe', async () => ({}));
  server.server.setRequestHandler('resources/unsubscribe', async () => ({}));
  return server;
}

export function createReferenceServer(fixture: McpLabFixture): McpServer {
  if (fixture === 'official-sdk-v2-everything-reference') {
    return createOfficialEverythingReferenceServer();
  }
  return createBrainstrikeEchoReferenceServer();
}
