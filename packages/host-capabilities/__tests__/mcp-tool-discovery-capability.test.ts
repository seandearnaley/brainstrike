import { type McpHostSnapshot, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import { parseMcpConfigValue } from '@brainstrike/assistant-contract/mcp-config';
import { describe, expect, it, vi } from 'vitest';
import { discoverToolsFromConfig } from '../src/mcp/tool-discovery.js';

const features = {
  completion: false,
  promptListChanged: false,
  prompts: false,
  resourceListChanged: false,
  resourceSubscriptions: false,
  resources: false,
  toolListChanged: false,
  tools: true,
};

function connected(name: string, tools: boolean): McpHostSnapshot['servers'][number] {
  return {
    catalog: {
      errors: {},
      features: { ...features, prompts: !tools, tools },
      subscription: { mode: 'none', state: 'unsupported' },
      ...(tools ? { tools: { tools: [] } } : {}),
    },
    configuredProtocol: 'legacy',
    configuredServerId: parseConfiguredMcpServerId(name),
    generation: 1,
    negotiated: { era: 'legacy', revision: '2025-11-25' },
    state: 'connected',
    transport: 'stdio',
  } as McpHostSnapshot['servers'][number];
}

/**
 * BST-1632: a prompts-only server advertises no tools capability. Discovery
 * once asked it for `tools/list` anyway; the SDK client refused, and the host
 * retired the server. Discovery now asks only servers that offer tools.
 */
describe('MCP tool discovery and the tools capability', () => {
  it('asks only the servers that advertise tools', async () => {
    const { config } = parseMcpConfigValue({
      servers: [
        {
          args: ['a.mjs'],
          command: 'node',
          name: 'with-tools',
          protocol: 'legacy',
          transport: 'stdio',
        },
        {
          args: ['b.mjs'],
          command: 'node',
          name: 'prompts-only',
          protocol: 'legacy',
          transport: 'stdio',
        },
      ],
    });
    const invoke = vi.fn(async () => ({
      result: { tools: [{ inputSchema: { type: 'object' }, name: 'echo' }] },
      type: 'tools/list' as const,
    }));

    const discovered = await discoverToolsFromConfig({ host: { invoke } } as never, config, {
      revision: 1,
      servers: [connected('with-tools', true), connected('prompts-only', false)],
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      configuredServerId: parseConfiguredMcpServerId('with-tools'),
      type: 'tools/list',
    });
    expect(discovered.map(({ server }) => server.name)).toEqual(['with-tools']);
  });
});
