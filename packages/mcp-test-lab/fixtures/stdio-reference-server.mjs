import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

function createReferenceServer() {
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

const inheritedEnvironmentKeys = DEFAULT_INHERITED_ENV_VARS.filter(
  (key) => process.env[key] !== undefined
);
if (inheritedEnvironmentKeys.length > 0) {
  throw new Error(
    `MCP lab stdio fixture inherited ambient environment keys: ${inheritedEnvironmentKeys.join(', ')}`
  );
}
process.stderr.write('mcp-lab-stdio-ready\n');
setImmediate(() => process.stderr.write('mcp-lab-stdio-ready-second-chunk\n'));
void serveStdio(createReferenceServer, { legacy: 'reject' });
