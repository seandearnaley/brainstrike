import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'brainstrike-mixed-media-stdio-fixture',
  version: '1.0.0',
});

server.registerTool(
  'multimodal',
  {
    description: 'Return structured content with bounded text, image, and audio.',
    inputSchema: {},
    outputSchema: {
      mediaCount: z.number(),
      provenance: z.string(),
    },
  },
  async () => ({
    content: [
      {
        text: `${'s'.repeat(9500)}mcp-stdio-multimodal-raw-only-tail`,
        type: 'text',
      },
      {
        data: 'aW1hZ2UtYnl0ZXM=',
        mimeType: 'image/png',
        type: 'image',
      },
      {
        data: 'YXVkaW8tYnl0ZXM=',
        mimeType: 'audio/wav',
        type: 'audio',
      },
    ],
    structuredContent: {
      mediaCount: 2,
      provenance: 'mixed-structured-stdio-media-fixture',
    },
  })
);

server.registerTool(
  'structured_only',
  {
    description: 'Return structured content without media.',
    inputSchema: {},
    outputSchema: {
      value: z.string(),
    },
  },
  async () => ({
    content: [{ text: 'legacy unstructured duplicate', type: 'text' }],
    structuredContent: {
      value: 'structured-stdio-only',
    },
  })
);

await server.connect(new StdioServerTransport());
