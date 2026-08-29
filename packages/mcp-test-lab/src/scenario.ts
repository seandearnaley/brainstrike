import type { McpLabFixture } from './faults.js';

export const MCP_LAB_SDK_VERSION = '2.0.0' as const;
export const MCP_LAB_CONFORMANCE_VERSION = '0.2.0-alpha.10' as const;

export const MCP_LAB_SDK_SOURCE = Object.freeze({
  commitSha: 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac',
  repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
  tag: `@modelcontextprotocol/server@${MCP_LAB_SDK_VERSION}`,
} as const);

export const MCP_LAB_SDK_SOURCE_SHA = MCP_LAB_SDK_SOURCE.commitSha;

export const MCP_LAB_SCENARIO_IDS = Object.freeze([
  'modern-reference',
  'legacy-reference',
  'stdio-reference',
  'oauth-reference',
] as const);

export type McpLabScenarioId = (typeof MCP_LAB_SCENARIO_IDS)[number];

export interface McpLabScenario {
  readonly authentication: 'none' | 'oauth';
  readonly description: string;
  readonly fixture: McpLabFixture;
  readonly id: McpLabScenarioId;
  readonly network: 'loopback-only';
  readonly protocol:
    | { readonly era: 'legacy'; readonly version: '2025-11-25' }
    | { readonly era: 'modern'; readonly version: '2026-07-28' };
  readonly reference: {
    readonly clientPackage: '@modelcontextprotocol/client';
    readonly conformancePackage: '@modelcontextprotocol/conformance';
    readonly conformanceVersion: typeof MCP_LAB_CONFORMANCE_VERSION;
    readonly sdkSource: typeof MCP_LAB_SDK_SOURCE;
    readonly sdkSourceSha: typeof MCP_LAB_SDK_SOURCE_SHA;
    readonly sdkVersion: typeof MCP_LAB_SDK_VERSION;
    readonly serverPackage: '@modelcontextprotocol/server';
  };
  readonly transport: 'stdio' | 'streamable-http';
  readonly usesAmbientCredentials: false;
}

const REFERENCE = Object.freeze({
  clientPackage: '@modelcontextprotocol/client',
  conformancePackage: '@modelcontextprotocol/conformance',
  conformanceVersion: MCP_LAB_CONFORMANCE_VERSION,
  sdkSource: MCP_LAB_SDK_SOURCE,
  sdkSourceSha: MCP_LAB_SDK_SOURCE_SHA,
  sdkVersion: MCP_LAB_SDK_VERSION,
  serverPackage: '@modelcontextprotocol/server',
} as const);

function freezeScenario(scenario: McpLabScenario): McpLabScenario {
  return Object.freeze({
    ...scenario,
    protocol: Object.freeze({ ...scenario.protocol }),
    reference: REFERENCE,
  });
}

const SCENARIOS: Readonly<Record<McpLabScenarioId, McpLabScenario>> = Object.freeze({
  'legacy-reference': freezeScenario({
    authentication: 'none',
    description: 'Brainstrike legacy-era compatibility server built with the pinned official SDK',
    fixture: 'brainstrike-sdk-v2-reference',
    id: 'legacy-reference',
    network: 'loopback-only',
    protocol: { era: 'legacy', version: '2025-11-25' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'modern-reference': freezeScenario({
    authentication: 'none',
    description: 'Brainstrike modern reference server built with the pinned official SDK',
    fixture: 'brainstrike-sdk-v2-reference',
    id: 'modern-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'oauth-reference': freezeScenario({
    authentication: 'oauth',
    description: 'Loopback OAuth protected-resource and authorization reference server',
    fixture: 'brainstrike-oauth-reference',
    id: 'oauth-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'stdio-reference': freezeScenario({
    authentication: 'none',
    description: 'Spawned stdio lifecycle and diagnostics reference server',
    fixture: 'brainstrike-stdio-reference',
    id: 'stdio-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'stdio',
    usesAmbientCredentials: false,
  }),
});

function isMcpLabScenarioId(value: string): value is McpLabScenarioId {
  return Object.hasOwn(SCENARIOS, value);
}

export function getMcpLabScenario(id: string): McpLabScenario {
  if (!isMcpLabScenarioId(id)) {
    throw new Error(`Unknown MCP lab scenario: ${id}`);
  }
  return SCENARIOS[id];
}
