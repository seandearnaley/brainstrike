import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OFFICIAL_EVERYTHING_PROFILE as profile } from './official-everything-profile.js';
import type { McpLabFixture } from './scenario.js';

function createBrainstrikeEchoReferenceServer(): McpServer {
  const server = new McpServer({
    name: 'brainstrike-sdk-v2-reference',
    version: '2.0.0',
  });
  const echoSchema = z.strictObject({ text: z.string() });
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
  const server = new McpServer(profile.server, { capabilities: profile.capabilities });

  server.registerTool(
    profile.tools.simpleText.name,
    { description: profile.tools.simpleText.description },
    async () => ({
      content: [{ text: profile.tools.simpleText.text, type: 'text' }],
    })
  );
  server.registerTool(
    profile.tools.error.name,
    { description: profile.tools.error.description },
    async () => {
      throw new Error(profile.tools.error.message);
    }
  );
  server.registerResource(
    profile.resource.name,
    profile.resource.uri,
    {
      description: profile.resource.description,
      mimeType: profile.resource.mimeType,
      title: profile.resource.title,
    },
    async () => ({
      contents: [
        {
          mimeType: profile.resource.mimeType,
          text: profile.resource.text,
          uri: profile.resource.uri,
        },
      ],
    })
  );
  server.registerPrompt(
    profile.prompt.name,
    {
      description: profile.prompt.description,
      title: profile.prompt.title,
    },
    async () => ({
      messages: [
        {
          content: { text: profile.prompt.message, type: 'text' },
          role: 'user',
        },
      ],
    })
  );
  server.server.setRequestHandler('completion/complete', async () => ({
    completion: { ...profile.completion, values: [...profile.completion.values] },
  }));
  return server;
}

export function createReferenceServer(fixture: McpLabFixture): McpServer {
  if (fixture === 'official-sdk-v2-everything-reference') {
    return createOfficialEverythingReferenceServer();
  }
  return createBrainstrikeEchoReferenceServer();
}
