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
  expectedProtocolVersion: '2025-11-25' | '2026-07-28';
  id: McpLabScenarioId;
  network: 'loopback-only';
  server:
    | 'brainstrike-oauth-reference'
    | 'brainstrike-stdio-reference'
    | 'official-typescript-sdk-v2-everything';
  transport: 'stdio' | 'streamable-http';
  usesAmbientCredentials: false;
}

const SCENARIOS: Readonly<Record<McpLabScenarioId, McpLabScenario>> = {
  'legacy-reference': {
    authentication: 'none',
    description: 'Pinned legacy-era MCP compatibility reference server',
    expectedProtocolVersion: '2025-11-25',
    id: 'legacy-reference',
    network: 'loopback-only',
    server: 'official-typescript-sdk-v2-everything',
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'modern-reference': {
    authentication: 'none',
    description: 'Pinned official TypeScript SDK v2 modern reference server',
    expectedProtocolVersion: '2026-07-28',
    id: 'modern-reference',
    network: 'loopback-only',
    server: 'official-typescript-sdk-v2-everything',
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'oauth-reference': {
    authentication: 'oauth',
    description: 'Loopback OAuth protected-resource and authorization reference server',
    expectedProtocolVersion: '2026-07-28',
    id: 'oauth-reference',
    network: 'loopback-only',
    server: 'brainstrike-oauth-reference',
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  },
  'stdio-reference': {
    authentication: 'none',
    description: 'Spawned stdio lifecycle and diagnostics reference server',
    expectedProtocolVersion: '2026-07-28',
    id: 'stdio-reference',
    network: 'loopback-only',
    server: 'brainstrike-stdio-reference',
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
