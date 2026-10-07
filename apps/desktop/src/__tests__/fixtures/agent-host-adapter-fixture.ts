import {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  createSanitizedToolNameMap,
  resolveAssistantResilienceConfig,
} from '@brainstrike/agent';
import { expect } from 'vitest';
import type {
  AgentHostAdapterCapabilities,
  AgentHostMcpCollection,
} from '../../agent-host-platform/adapter-services';

export const fixtureCapabilities: AgentHostAdapterCapabilities<AgentHostMcpCollection> = {
  attachElicitationPresenter: (presenter) =>
    presenter.attach(() => {
      throw new Error('This fixture did not request an elicitation.');
    }),
  collectCombinedTools: async ({ mcpClient, toolNameMap }) => {
    const discovered = await mcpClient?.listToolsetsWithErrors();
    expect(discovered?.errors ?? {}).toEqual({});
    const namespaced = Object.fromEntries(
      Object.entries(discovered?.toolsets ?? {}).flatMap(([server, tools]) =>
        Object.entries(tools).map(([name, tool]) => [`${server}.${name}`, tool])
      )
    );
    const names = createSanitizedToolNameMap(Object.keys(namespaced));
    for (const [name, canonicalId] of names) {
      toolNameMap.set(name, canonicalId);
    }
    return {
      mcpDiscoverySkips: [],
      tools: Object.fromEntries([...names].map(([name, id]) => [name, namespaced[id]!])),
    };
  },
  createProviderCredentialReader: (secrets) => async (provider) => {
    const credential = await secrets.getCredential(provider);
    return credential ? { ...credential, source: 'stored' } : undefined;
  },
  onMcpDiscoverySkips: async (skips) => {
    expect(skips).toEqual([]);
  },
};

export const fixtureToolRequest = {
  resolvedToolResultBudget: CEILING_SCALED_TOOL_RESULT_BUDGET,
  toolTimeoutMs: resolveAssistantResilienceConfig().toolTimeoutMs,
};
