import { createAgentHub } from '@brainstrike/agent-hub';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentHubRuntimeConfig,
  DEFAULT_AGENT_HUB_CONFIG,
} from '../agent-hub/agent-hub-config';
import {
  type AgentHubServerManager,
  createAgentHubServerManager,
} from '../agent-hub/agent-hub-server-manager';

const managers: AgentHubServerManager[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(managers.splice(0).map((manager) => manager.stop().catch(() => {})));
});

function testConfig(overrides: Partial<AgentHubRuntimeConfig> = {}): AgentHubRuntimeConfig {
  return { ...DEFAULT_AGENT_HUB_CONFIG, enabled: true, port: 0, ...overrides };
}

async function startManager(overrides: Partial<AgentHubRuntimeConfig> = {}) {
  const hub = createAgentHub();
  const manager = createAgentHubServerManager({ config: testConfig(overrides), hub });
  managers.push(manager);
  const status = await manager.start();
  if (!status.url) {
    throw new Error('manager did not report a url');
  }
  return { hub, manager, url: status.url };
}

async function connectClient(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token === undefined
      ? undefined
      : { requestInit: { headers: { authorization: `Bearer ${token}` } } }
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

interface ToolCallOutcome {
  isError: boolean;
  payload: unknown;
  text: string;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallOutcome> {
  const result = await client.callTool({ arguments: args, name });
  const content = result.content as Array<{ text?: string; type: string }> | undefined;
  const text = content?.[0]?.text ?? '';
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { isError: result.isError === true, payload, text };
}

describe('agent hub server manager', () => {
  it('starts on an ephemeral port and reports a running status', async () => {
    const { manager } = await startManager();
    const status = manager.getStatus();
    expect(status.state).toBe('running');
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(status.connectionCount).toBe(0);
    expect(status.error).toBeNull();
  });

  it('refuses to start when binding 0.0.0.0 without an auth token', async () => {
    const hub = createAgentHub();
    const manager = createAgentHubServerManager({
      config: testConfig({ bindAddress: '0.0.0.0' }),
      hub,
    });
    managers.push(manager);
    await expect(manager.start()).rejects.toThrow(/auth token/i);
    expect(manager.getStatus().state).toBe('error');
  });

  it('exposes hub tools but not context_search without a provider', async () => {
    const { url } = await startManager();
    const client = await connectClient(url);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'hub_list_agents',
      'hub_read_messages',
      'hub_register',
      'hub_send_message',
      'hub_whoami',
      'vfs_list',
      'vfs_read',
      'vfs_write',
    ]);
  });

  it('requires hub_register before other tools', async () => {
    const { url } = await startManager();
    const client = await connectClient(url);
    const outcome = await callTool(client, 'hub_send_message', { text: 'hello' });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/hub_register/);
  });

  it('registers agents and lets two sessions chat with budgets respected', async () => {
    const { hub, manager, url } = await startManager();
    const alpha = await connectClient(url);
    const beta = await connectClient(url);

    const registered = await callTool(alpha, 'hub_register', {
      name: 'alpha',
      program: 'claude-code',
      worktree: '/tmp/wt-alpha',
    });
    expect(registered.isError).toBe(false);
    const alphaIdentity = registered.payload as { agent: { color: string; name: string } };
    expect(alphaIdentity.agent.name).toBe('alpha');
    expect(alphaIdentity.agent.color).toBe('chart-1');

    await callTool(beta, 'hub_register', { name: 'beta' });
    expect(manager.getStatus().connectionCount).toBe(2);

    const roster = await callTool(alpha, 'hub_list_agents', {});
    const rosterPayload = roster.payload as { agents: Array<{ name: string }> };
    expect(rosterPayload.agents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(['brainstrike', 'alpha', 'beta'])
    );

    await callTool(alpha, 'hub_send_message', { text: 'a'.repeat(20) });
    await callTool(alpha, 'hub_send_message', { text: 'b'.repeat(20) });
    const read = await callTool(beta, 'hub_read_messages', { maxTokens: 5 });
    const readPayload = read.payload as {
      messages: Array<{ text: string }>;
      tokensUsed: number;
      truncated: boolean;
    };
    expect(readPayload.messages).toHaveLength(1);
    expect(readPayload.messages[0]?.text).toBe('b'.repeat(20));
    expect(readPayload.truncated).toBe(true);
    expect(hub.listAgents().find((agent) => agent.name === 'beta')?.tokensReceived).toBe(5);
  });

  it('rejects requests without the configured bearer token', async () => {
    const { url } = await startManager({ authToken: 'shhh-secret' });
    await expect(connectClient(url)).rejects.toThrow(/unauthorized/i);
    const client = await connectClient(url, 'shhh-secret');
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });

  it('marks agents offline when their session terminates', async () => {
    const { hub, manager, url } = await startManager();
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    clients.push(client);
    await callTool(client, 'hub_register', { name: 'ghost' });
    expect(manager.getStatus().connectionCount).toBe(1);
    await transport.terminateSession();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.getStatus().connectionCount).toBe(0);
    expect(hub.listAgents().find((agent) => agent.name === 'ghost')?.status).toBe('offline');
  });

  it('stop() flips status to stopped and applyConfig restarts on demand', async () => {
    const { manager, url } = await startManager();
    await manager.stop();
    expect(manager.getStatus().state).toBe('stopped');
    const restarted = await manager.applyConfig(testConfig());
    expect(restarted.state).toBe('running');
    expect(restarted.url).not.toBeNull();
    expect(restarted.url).not.toBe(url);
  });

  it('exposes the virtual file system over MCP tools', async () => {
    const { url } = await startManager();
    const writer = await connectClient(url);
    const reader = await connectClient(url);
    await callTool(writer, 'hub_register', { name: 'writer' });
    await callTool(reader, 'hub_register', { name: 'reader' });

    const written = await callTool(writer, 'vfs_write', {
      content: '# Plan\n'.repeat(20),
      name: 'plan.md',
    });
    expect(written.isError).toBe(false);
    const entry = written.payload as { entry: { path: string; tokenCount: number } };
    expect(entry.entry.path).toBe('/agents/writer/shared/plan.md');

    const listed = await callTool(reader, 'vfs_list', {});
    const listPayload = listed.payload as { entries: Array<{ path: string }> };
    expect(listPayload.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(['/agents/writer/shared/plan.md', '/channels/#general.md'])
    );

    const read = await callTool(reader, 'vfs_read', {
      maxTokens: 10,
      path: '/agents/writer/shared/plan.md',
    });
    const readPayload = read.payload as { nextOffsetTokens: number; truncated: boolean };
    expect(readPayload.truncated).toBe(true);
    expect(readPayload.nextOffsetTokens).toBe(10);
  });

  it('registers context_search when a provider is supplied', async () => {
    const hub = createAgentHub();
    const manager = createAgentHubServerManager({
      config: testConfig(),
      contextProvider: {
        search: ({ query }) => Promise.resolve({ text: `ctx:${query}`, tokensUsed: 3 }),
      },
      hub,
    });
    managers.push(manager);
    const status = await manager.start();
    const client = await connectClient(status.url ?? '');
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'context_search')).toBe(true);
    await callTool(client, 'hub_register', { name: 'searcher' });
    const outcome = await callTool(client, 'context_search', { query: 'hello' });
    const payload = outcome.payload as { text: string; tokensUsed: number };
    expect(payload.text).toBe('ctx:hello');
    expect(payload.tokensUsed).toBe(3);
  });
});
