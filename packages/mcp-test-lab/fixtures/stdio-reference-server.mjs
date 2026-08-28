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
      description: 'Echo a string through the official MCP TypeScript SDK v2 stdio server.',
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

const delayMs = Number.parseInt(process.env.MCP_LAB_START_DELAY_MS ?? '0', 10);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.MCP_LAB_STDERR_TEXT) {
  process.stderr.write(`${process.env.MCP_LAB_STDERR_TEXT}\n`);
}
if (process.env.MCP_LAB_MALFORMED_JSON) {
  process.stdout.write(`${process.env.MCP_LAB_MALFORMED_JSON}\n`);
}
if (process.env.MCP_LAB_EXIT_SIGNAL) {
  process.kill(process.pid, process.env.MCP_LAB_EXIT_SIGNAL);
} else if (process.env.MCP_LAB_EXIT_CODE) {
  process.exit(Number.parseInt(process.env.MCP_LAB_EXIT_CODE, 10));
} else if (process.env.MCP_LAB_DROP_RESPONSE !== '1') {
  void serveStdio(createReferenceServer, { legacy: 'reject' });
}
