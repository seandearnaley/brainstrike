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
    evidence:
      'Typed resources, templates, prompts, completions, pagination, cache hints, and era-correct change delivery.',
    id: 'core:server-features',
    implementationTicket: 'BST-1471',
    kind: 'core',
    label: 'MCP core server features',
    status: 'supported',
  },
  {
    evidence:
      'Form and URL elicitation are advertised per connection and answered by the accessible desktop consent dialog; provenance-bound settlement, one-use URL grants, and generation retirement.',
    id: 'core:elicitation',
    implementationTicket: 'BST-1584',
    kind: 'core',
    label: 'MCP elicitation',
    status: 'supported',
  },
  {
    evidence:
      'Registered by the desktop default extension registry, dedicated mcp-app sandbox startup, live-run admission authority, and visible-UI Apps IPC/preload bridge.',
    id: 'io.modelcontextprotocol/ui',
    implementationTicket: 'BST-1572',
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
    status: 'supported',
  },
  {
    evidence:
      'Desktop main registers the Tasks wire contracts on stdio and streamable-http connections and runs the durable task host: repository handles, the sole-authority poller, mid-flight input and cancellation, and renderer status cards. Legacy sse connections register no extensions.',
    id: 'io.modelcontextprotocol/tasks',
    implementationTicket: 'BST-1566',
    kind: 'extension',
    label: 'MCP Tasks',
    status: 'supported',
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

export const MCP_CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'authentication-required',
  'authorizing',
  'connected',
  'closing',
  'error',
] as const;

export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];

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
