import {
  type ElicitRequestFormParams,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server';
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
  const elicitConfirmOutputSchema = z.strictObject({ confirmed: z.boolean(), text: z.string() });
  server.registerTool(
    'elicit_confirm',
    {
      description:
        'Ask the connected client to confirm a string through MCP form elicitation before echoing it.',
      inputSchema: echoSchema,
      outputSchema: elicitConfirmOutputSchema,
    },
    async ({ text }, ctx) => {
      const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        properties: {
          confirm: {
            description: `Confirm that "${text}" may be echoed back.`,
            title: 'Confirm',
            type: 'boolean',
          },
          note: { maxLength: 80, title: 'Note', type: 'string' },
        },
        required: ['confirm'],
        type: 'object',
      };
      const message = `Confirm the reference elicitation for "${text}".`;
      const negotiated = server.server.getNegotiatedProtocolVersion();
      let confirmed: boolean;
      if (negotiated === '2026-07-28') {
        // Modern era: elicitation rides the multi-round-trip result. The client
        // answers the embedded request and retries with `inputResponses`; a
        // decline or cancel is a final answer, never a reason to re-ask.
        const answer = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        if (answer.kind === 'missing') {
          return inputRequired({
            inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema }) },
          });
        }
        confirmed =
          answer.kind === 'elicit' &&
          answer.action === 'accept' &&
          answer.content?.['confirm'] === true;
      } else {
        // Legacy era: the 2025 push-style server-to-client request.
        const result = await ctx.mcpReq.elicitInput({ message, mode: 'form', requestedSchema });
        confirmed = result.action === 'accept' && result.content?.['confirm'] === true;
      }
      const echoed = confirmed ? text : 'elicitation was not accepted';
      return {
        content: [{ text: echoed, type: 'text' }],
        structuredContent: { confirmed, text: echoed },
      };
    }
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
