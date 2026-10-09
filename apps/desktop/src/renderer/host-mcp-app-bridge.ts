import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  McpAppBridge,
  McpAppOrigin,
  McpAppPrepareRequest,
  McpAppShellBridge,
} from '@brainstrike/assistant-contract';
import { resolveMcpAppShellBridge } from './mcp-app-bridge';
import { unwrapContent } from './mcp-content-outcome';

interface Preparation {
  readonly approved: boolean;
  readonly controller: AbortController;
  readonly request: McpAppPrepareRequest;
}

/**
 * An app's document, read from the agent host (BST-1930 c5d): the server's
 * live generation from its status, then that generation's resource. Only a
 * text body of the app's declared MIME type renders.
 */
async function readAppDocument(client: HostClient, origin: McpAppOrigin): Promise<string> {
  const status = await client.request('mcp/status/read', {});
  const server = status.servers.find(
    ({ configuredServerId }) => configuredServerId === origin.serverId
  );
  if (!server) {
    throw new Error(`MCP Apps server "${origin.serverId}" has no live content authority`);
  }
  const read = unwrapContent(
    await client.request('mcp/content/read', {
      authority: { configuredServerId: origin.serverId, generation: server.generation },
      uri: origin.resourceUri,
    })
  );
  const content = read.result.contents.find(({ uri }) => uri === origin.resourceUri);
  if (!(content && 'text' in content) || typeof content.text !== 'string') {
    throw new Error(`MCP Apps resource "${origin.resourceUri}" has no text content`);
  }
  if (content.mimeType !== origin.mimeType) {
    throw new Error(
      `MCP Apps resource "${origin.resourceUri}" MIME type must be "${origin.mimeType}"`
    );
  }
  return content.text;
}

/**
 * MCP Apps on a host thread. Main serves each app's shell, the host its
 * document (c5d); Core admits and runs every tool call the app makes, under
 * the thread's policy.
 * Core keeps no preparation: `prepare` asks it for the decision, and
 * `execute` sends the same call again with the user's answer, which Core
 * decides afresh. Releasing a call the host is still running (the app closed,
 * or its request timed out) cancels it there. `null` without a shell bridge.
 */
export function hostMcpAppBridge(
  client: HostClient,
  shell: McpAppShellBridge | null = resolveMcpAppShellBridge()
): McpAppBridge | null {
  if (!shell) {
    return null;
  }
  const preparations = new Map<string, Preparation>();
  const call = ({ arguments: input, origin, threadId, toolName }: McpAppPrepareRequest) => ({
    app: origin,
    arguments: input,
    threadId,
    toolName,
  });
  return {
    execute: async ({ preparationId }) => {
      const preparation = preparations.get(preparationId);
      if (!preparation) {
        throw new Error('The MCP App tool call is not prepared');
      }
      try {
        // The app's authority executes a call Core asked about only once the user allowed it.
        return await client.request(
          'mcp/app/call',
          { ...call(preparation.request), approved: preparation.approved },
          preparation.controller.signal
        );
      } finally {
        preparations.delete(preparationId);
      }
    },
    prepare: async (request) => {
      if (preparations.has(request.preparationId)) {
        throw new Error('The MCP App preparation id is already in use');
      }
      const admitted = await client.request('mcp/app/admit', call(request));
      preparations.set(request.preparationId, {
        approved: admitted.decision === 'ask',
        controller: new AbortController(),
        request,
      });
      return admitted;
    },
    prepareShell: (request) => shell.prepareShell(request),
    readResource: (origin) => readAppDocument(client, origin),
    release: async ({ preparationId }) => {
      preparations.get(preparationId)?.controller.abort(new Error('MCP App tool call released'));
      preparations.delete(preparationId);
    },
    releaseShell: (request) => shell.releaseShell(request),
  };
}
