export const MCP_LAB_SDK_VERSION = '2.0.0' as const;
export const MCP_LAB_SDK_SOURCE_SHA = 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac' as const;
export const MCP_LAB_CONFORMANCE_VERSION = '0.2.0-alpha.10' as const;

export const MCP_LAB_SCENARIO_IDS = [
  'modern-reference',
  'legacy-reference',
  'stdio-reference',
  'oauth-reference',
] as const;

export type McpLabScenarioId = (typeof MCP_LAB_SCENARIO_IDS)[number];

export interface McpLabScenario {
  authentication: 'none' | 'oauth';
  description: string;
  fixture:
    | 'brainstrike-sdk-v2-reference'
    | 'brainstrike-oauth-reference'
    | 'brainstrike-stdio-reference';
  id: McpLabScenarioId;
  network: 'loopback-only';
  protocol: { era: 'legacy'; version: '2025-11-25' } | { era: 'modern'; version: '2026-07-28' };
  reference: {
    clientPackage: '@modelcontextprotocol/client';
    conformancePackage: '@modelcontextprotocol/conformance';
    conformanceVersion: typeof MCP_LAB_CONFORMANCE_VERSION;
    sdkSourceSha: typeof MCP_LAB_SDK_SOURCE_SHA;
    sdkVersion: typeof MCP_LAB_SDK_VERSION;
    serverPackage: '@modelcontextprotocol/server';
  };
  transport: 'stdio' | 'streamable-http';
  usesAmbientCredentials: false;
}

const REFERENCE = {
  clientPackage: '@modelcontextprotocol/client',
  conformancePackage: '@modelcontextprotocol/conformance',
  conformanceVersion: MCP_LAB_CONFORMANCE_VERSION,
  sdkSourceSha: MCP_LAB_SDK_SOURCE_SHA,
  sdkVersion: MCP_LAB_SDK_VERSION,
  serverPackage: '@modelcontextprotocol/server',
} as const;

const SCENARIOS: Readonly<Record<McpLabScenarioId, McpLabScenario>> = {
  'legacy-reference': {
    authentication: 'none',
    description: 'Brainstrike legacy-era compatibility server built with the pinned official SDK',
    fixture: 'brainstrike-sdk-v2-reference',
    id: 'legacy-reference',
    network: 'loopback-only',
    protocol: { era: 'legacy', version: '2025-11-25' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'modern-reference': {
    authentication: 'none',
    description: 'Brainstrike modern reference server built with the pinned official SDK',
    fixture: 'brainstrike-sdk-v2-reference',
    id: 'modern-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'oauth-reference': {
    authentication: 'oauth',
    description: 'Loopback OAuth protected-resource and authorization reference server',
    fixture: 'brainstrike-oauth-reference',
    id: 'oauth-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'stdio-reference': {
    authentication: 'none',
    description: 'Spawned stdio lifecycle and diagnostics reference server',
    fixture: 'brainstrike-stdio-reference',
    id: 'stdio-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'stdio',
    usesAmbientCredentials: false,
  },
};

function isMcpLabScenarioId(value: string): value is McpLabScenarioId {
  return Object.hasOwn(SCENARIOS, value);
}

export function getMcpLabScenario(id: string): McpLabScenario {
  if (!isMcpLabScenarioId(id)) {
    throw new Error(`Unknown MCP lab scenario: ${id}`);
  }
  return SCENARIOS[id];
}
