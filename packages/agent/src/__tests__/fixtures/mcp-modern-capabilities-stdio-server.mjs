import { writeFile } from 'node:fs/promises';
import { CLIENT_CAPABILITIES_META_KEY, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const capabilitiesFile = process.env['BRAINSTRIKE_STDIO_TEST_CAPABILITIES_FILE'];
if (!capabilitiesFile) {
  throw new Error('BRAINSTRIKE_STDIO_TEST_CAPABILITIES_FILE is required');
}

function createServer() {
  const server = new McpServer({
    name: 'brainstrike-modern-capabilities-fixture',
    version: '1.0.0',
  });
  server.registerTool(
    'inspect_env',
    { description: 'Record modern request capabilities.' },
    async (ctx) => {
      const capabilities = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY];
      await writeFile(capabilitiesFile, JSON.stringify(capabilities ?? null), 'utf8');
      return { content: [{ text: 'capabilities recorded', type: 'text' }] };
    }
  );
  return server;
}

void serveStdio(createServer, { legacy: 'reject' });
