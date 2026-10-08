import {
  type CollectCombinedToolsResult,
  collectCombinedTools,
} from '@brainstrike/agent/mcp-client';
import {
  type AgentHostAdapterCapabilities,
  createAgentHostAdapterServicesFactory,
} from '@brainstrike/host-capabilities/mcp/adapter-services';
import { createProviderCredentialReader } from '../provider-credential-boundary';

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
