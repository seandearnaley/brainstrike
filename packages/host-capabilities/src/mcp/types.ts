import type { NegotiatedProtocolFacts } from '@brainstrike/agent/mcp-client';
import type {
  McpServerIdentity,
  McpServerStatusSnapshot,
  McpStatusBase,
} from '@brainstrike/assistant-contract';

export interface McpDiscoveredTool {
  description?: string;
  inputSchema?: unknown;
}

export function connectedStatus(
  source: NegotiatedProtocolFacts,
  base: McpStatusBase
): McpServerStatusSnapshot {
  const era = source.getProtocolEra();
  const revision = source.getNegotiatedProtocolVersion();
  if (!(era && revision)) {
    return {
      ...base,
      error: 'Connected MCP client has no negotiated protocol facts',
      state: 'error',
    };
  }
  const capabilities = source.getServerCapabilities();
  const rawServerIdentity = source.getServerVersion();
  const serverIdentity: McpServerIdentity | undefined = rawServerIdentity
    ? {
        ...(rawServerIdentity.description ? { description: rawServerIdentity.description } : {}),
        name: rawServerIdentity.name,
        ...(rawServerIdentity.title ? { title: rawServerIdentity.title } : {}),
        version: rawServerIdentity.version,
        ...(rawServerIdentity.websiteUrl ? { websiteUrl: rawServerIdentity.websiteUrl } : {}),
      }
    : undefined;
  return {
    ...base,
    negotiated: {
      ...(capabilities ? { advertisedCapabilityIds: Object.keys(capabilities).sort() } : {}),
      era,
      revision,
      ...(serverIdentity ? { serverIdentity } : {}),
    },
    state: 'connected',
  };
}

export function mcpStatusErrorMessage(error: unknown): string {
  const record = typeof error === 'object' && error !== null ? error : undefined;
  const status = record && 'status' in record ? record.status : undefined;
  return typeof status === 'number' && Number.isInteger(status)
    ? `MCP connection failed (HTTP ${status})`
    : 'MCP connection failed';
}
