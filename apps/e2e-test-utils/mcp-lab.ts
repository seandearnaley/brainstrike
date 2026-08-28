import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMcpLabScenario, type McpLabScenario } from './mcp-lab-manifest';

export interface McpLabSession {
  close: () => Promise<void>;
  readonly closed: boolean;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  scenario: McpLabScenario;
}

function createModernReferenceServer(): McpServer {
  const server = new McpServer({
    name: 'brainstrike-official-v2-reference',
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

export function createMcpLabScenario(id: string): McpLabSession {
  const scenario = getMcpLabScenario(id);
  if (scenario.id !== 'modern-reference') {
    throw new Error(`MCP lab scenario is not implemented: ${scenario.id}`);
  }

  const handler = createMcpHandler(createModernReferenceServer, { legacy: 'reject' });
  let closed = false;

  return {
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await handler.close();
    },
    get closed() {
      return closed;
    },
    async fetch(input, init) {
      if (closed) {
        throw new Error(`MCP lab scenario is closed: ${scenario.id}`);
      }
      return handler.fetch(new Request(input, init));
    },
    scenario,
  };
}
