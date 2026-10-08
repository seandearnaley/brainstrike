import {
  type CollectCombinedToolsResult,
  collectCombinedTools,
} from '@brainstrike/agent/mcp-client';
import { createProviderCredentialReader } from '@brainstrike/host-capabilities/provider-credentials';
import {
  type AgentHostAdapterCapabilities,
  createAgentHostAdapterServicesFactory,
} from './adapter-services';

/** Bind the existing collector and credential policy once for the root composition. */
export function createProductionAgentHostAdapterServicesFactory(
  capabilities: Omit<
    AgentHostAdapterCapabilities<CollectCombinedToolsResult>,
    'collectCombinedTools' | 'createProviderCredentialReader'
  >
): ReturnType<typeof createAgentHostAdapterServicesFactory<CollectCombinedToolsResult>> {
  return createAgentHostAdapterServicesFactory({
    ...capabilities,
    collectCombinedTools,
    createProviderCredentialReader,
  });
}
