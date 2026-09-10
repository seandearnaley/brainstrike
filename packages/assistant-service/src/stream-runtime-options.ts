import type { ProviderAuthInput, ToolOutputArtifactSettlementStore } from '@brainstrike/agent';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { AssistantStreamRuntimeOptions } from './ports.js';
import type { AgentStreamMemoryResult } from './stream-init.js';

type McpRuntimeHosts = {
  [K in 'mcpAppAdmission' | 'mcpHost' | 'mcpTaskTracking']:
    | AssistantStreamRuntimeOptions[K]
    | undefined;
};

export function buildInitialStreamMemoryOptions(
  memoryResult: AgentStreamMemoryResult | undefined,
  toolOutputArtifactStore: ToolOutputArtifactSettlementStore | undefined,
  webExtractInlineMaxSerializedChars: number,
  authInput: ProviderAuthInput | undefined,
  hosts: McpRuntimeHosts
): AssistantStreamRuntimeOptions {
  return {
    ...(authInput ? { authInput } : {}),
    ...(hosts.mcpHost ? { mcpHost: hosts.mcpHost } : {}),
    ...(hosts.mcpAppAdmission ? { mcpAppAdmission: hosts.mcpAppAdmission } : {}),
    ...(hosts.mcpTaskTracking ? { mcpTaskTracking: hosts.mcpTaskTracking } : {}),
    ...(memoryResult ? { memory: memoryResult.memory, storage: memoryResult.storage } : {}),
    ...(memoryResult?.conversationBinding
      ? { conversationBinding: memoryResult.conversationBinding }
      : {}),
    ...(toolOutputArtifactStore
      ? {
          toolOutputArtifactInlineMaxSerializedCharsByToolName: new Map([
            [NATIVE_TOOL_ID.webExtract, webExtractInlineMaxSerializedChars],
          ]),
          toolOutputArtifactStore,
        }
      : {}),
  };
}
