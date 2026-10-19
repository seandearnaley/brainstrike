// Explicit @brainstrike/agent test-fixture export; never used by production entrypoints.
//
// A stdio MCP server whose catalog has one of the shapes Settings must name
// honestly (BST-1632), chosen by BRAINSTRIKE_STDIO_CATALOG_SHAPE:
// - `empty-tools`: advertises the tools capability and lists zero tools.
// - `prompts-only`: advertises prompts and no tools capability at all.
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const shape = process.env['BRAINSTRIKE_STDIO_CATALOG_SHAPE'];
if (shape !== 'empty-tools' && shape !== 'prompts-only') {
  throw new Error('BRAINSTRIKE_STDIO_CATALOG_SHAPE must be empty-tools or prompts-only');
}

const server = new Server(
  { name: `brainstrike-desktop-stdio-${shape}-fixture`, version: '1.0.0' },
  { capabilities: shape === 'empty-tools' ? { tools: {} } : { prompts: {} } }
);
if (shape === 'empty-tools') {
  server.setRequestHandler('tools/list', async () => ({ tools: [] }));
} else {
  server.setRequestHandler('prompts/list', async () => ({
    prompts: [{ description: 'A fixture prompt.', name: 'fixture_prompt' }],
  }));
}

await server.connect(new StdioServerTransport());
