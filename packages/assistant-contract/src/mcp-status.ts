export type McpConfiguredProtocol = '2026-07-28' | 'auto' | 'legacy';
export type McpStatusTransport = 'sse' | 'stdio' | 'streamable-http';

export interface McpSupportMatrixEntry {
  evidence: string;
  id: string;
  implementationTicket: `BST-${number}` | null;
  kind: 'core' | 'extension';
  label: string;
  requirements?: readonly string[];
  status: 'supported' | 'unsupported';
}

/** Browser-safe product support facts. Renderers display these; they never infer support. */
export const MCP_SUPPORT_MATRIX = [
  {
    evidence: 'SDK v2 with explicit 2026-07-28 negotiation and core tool calls.',
    id: 'core:2026-07-28-tools',
    implementationTicket: 'BST-1463',
    kind: 'core',
    label: 'MCP 2026 core transport and tools',
    status: 'supported',
  },
  {
    evidence: 'No complete Apps host is registered.',
    id: 'io.modelcontextprotocol/ui',
    implementationTicket: 'BST-1474',
    kind: 'extension',
    label: 'MCP Apps',
    requirements: [
      'MIME declaration',
      'ui:// resource loading',
      'tool/result association',
      'sandbox/CSP',
      'bidirectional validation',
      'permission/consent',
      'lifecycle cleanup',
      'renderer tests',
    ],
    status: 'unsupported',
  },
  {
    evidence: 'No complete durable task host is registered.',
    id: 'io.modelcontextprotocol/tasks',
    implementationTicket: 'BST-1473',
    kind: 'extension',
    label: 'MCP Tasks',
    status: 'unsupported',
  },
  {
    evidence: 'No machine-to-machine credential host is registered.',
    id: 'io.modelcontextprotocol/oauth-client-credentials',
    implementationTicket: null,
    kind: 'extension',
    label: 'OAuth Client Credentials',
    status: 'unsupported',
  },
  {
    evidence: 'No managed-enterprise authorization host is registered.',
    id: 'io.modelcontextprotocol/enterprise-managed-authorization',
    implementationTicket: null,
    kind: 'extension',
    label: 'Enterprise-Managed Authorization',
    status: 'unsupported',
  },
] as const satisfies readonly McpSupportMatrixEntry[];

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
