import type { AgentHub } from '@brainstrike/agent-hub';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface AgentHubContextProvider {
  search(input: {
    maxTokens: number;
    query: string;
  }): Promise<{ text: string; tokensUsed: number }>;
}

export interface BuildAgentHubMcpServerOptions {
  contextProvider?: AgentHubContextProvider;
  /** Resolves the MCP session id for the current connection (set after initialize). */
  getSessionKey: () => string;
  hub: AgentHub;
}

const SERVER_INFO = { name: 'brainstrike-agent-hub', version: '0.1.0' };
const DEFAULT_CONTEXT_SEARCH_MAX_TOKENS = 2000;

function jsonResult(payload: unknown): {
  content: Array<{ text: string; type: 'text' }>;
} {
  return { content: [{ text: JSON.stringify(payload), type: 'text' }] };
}

/**
 * Builds the per-session MCP server exposing the hub tools. Tool errors are
 * surfaced by the SDK as isError results, so handlers throw plain Errors with
 * actionable messages (e.g. "Call hub_register first").
 */
export function buildAgentHubMcpServer(options: BuildAgentHubMcpServerOptions): McpServer {
  const { contextProvider, getSessionKey, hub } = options;
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    'hub_register',
    {
      description:
        'Register this agent with the Brainstrike hub. Returns your identity (id, unique name, color) and the channel list. Call this once before any other hub tool.',
      inputSchema: {
        capabilities: z.array(z.string()).optional(),
        name: z.string().describe('Display name, e.g. "claude-worktree-a"'),
        program: z.string().optional().describe('Agent program, e.g. "claude-code"'),
        worktree: z.string().optional().describe('Absolute path of the worktree you operate in'),
      },
    },
    (args) => {
      const agent = hub.registerAgent({ ...args, sessionKey: getSessionKey() });
      return jsonResult({ agent, channels: hub.listChannels() });
    }
  );

  server.registerTool(
    'hub_whoami',
    {
      description: 'Return your registered hub identity.',
      inputSchema: {},
    },
    () => {
      const agent = hub.getAgentBySessionKey(getSessionKey());
      if (!agent) {
        throw new Error('Not registered. Call hub_register first.');
      }
      return jsonResult({ agent });
    }
  );

  server.registerTool(
    'hub_list_agents',
    {
      description:
        'List all agents known to the hub (online and offline), including token usage counters.',
      inputSchema: {},
    },
    () => {
      requireRegistered(hub, getSessionKey());
      return jsonResult({ agents: hub.listAgents() });
    }
  );

  server.registerTool(
    'hub_send_message',
    {
      description:
        'Post a chat message to a hub channel (default #general). Unknown channels are created on demand.',
      inputSchema: {
        channel: z.string().optional().describe('Channel name, e.g. "#general"'),
        mentions: z.array(z.string()).optional().describe('Agent names being addressed'),
        text: z.string(),
      },
    },
    (args) => {
      const message = hub.postMessage({ ...args, sessionKey: getSessionKey() });
      return jsonResult({ message });
    }
  );

  server.registerTool(
    'hub_read_messages',
    {
      description:
        'Read channel messages newest-first within a token budget. Use sinceId for incremental polling; the result reports tokensUsed/truncated so you can stay inside your context budget.',
      inputSchema: {
        channel: z.string().optional(),
        limit: z.number().int().positive().optional(),
        maxTokens: z.number().int().positive().optional(),
        sinceId: z.number().int().nonnegative().optional(),
      },
    },
    (args) => {
      const result = hub.readMessages({ ...args, sessionKey: getSessionKey() });
      return jsonResult(result);
    }
  );

  if (contextProvider) {
    server.registerTool(
      'context_search',
      {
        description:
          "Search Brainstrike's indexed workspace context. Returns packed, token-budgeted context text.",
        inputSchema: {
          maxTokens: z.number().int().positive().optional(),
          query: z.string(),
        },
      },
      async (args) => {
        requireRegistered(hub, getSessionKey());
        const result = await contextProvider.search({
          maxTokens: args.maxTokens ?? DEFAULT_CONTEXT_SEARCH_MAX_TOKENS,
          query: args.query,
        });
        return jsonResult(result);
      }
    );
  }

  return server;
}

function requireRegistered(hub: AgentHub, sessionKey: string): void {
  if (!hub.getAgentBySessionKey(sessionKey)) {
    throw new Error('Not registered. Call hub_register first.');
  }
}
