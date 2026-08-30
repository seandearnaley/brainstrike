export type McpConfiguredProtocol = '2026-07-28' | 'auto' | 'legacy';
export type McpStatusTransport = 'sse' | 'stdio' | 'streamable-http';

export interface McpServerIdentity {
  description?: string;
  name: string;
  title?: string;
  version: string;
  websiteUrl?: string;
}

export interface McpNegotiatedStatus {
  advertisedCapabilityIds?: string[];
  era: 'legacy' | 'modern';
  revision: string;
  serverIdentity?: McpServerIdentity;
}

export interface McpStatusBase {
  configuredProtocol: McpConfiguredProtocol;
  name: string;
  transport: McpStatusTransport;
}

export type McpServerStatusSnapshot = McpStatusBase &
  (
    | { state: 'connecting' | 'disconnected' }
    | { error: string; state: 'error' }
    | { negotiated: McpNegotiatedStatus; state: 'connected' }
  );
