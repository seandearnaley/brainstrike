import { APPS_PROFILE_SHA256 } from './apps-profile.js';
import { OFFICIAL_EVERYTHING_PROFILE_SHA256 } from './official-everything-profile.js';
import { TASKS_PROFILE_SHA256 } from './tasks-profile.js';

export const MCP_LAB_SDK_VERSION = '2.0.0' as const;
export const MCP_LAB_CONFORMANCE_VERSION = '0.2.0-alpha.10' as const;

export const MCP_LAB_CONFORMANCE_SOURCE = Object.freeze({
  commitSha: 'a9896553900a2ef61787b57adfcbbe936a8ab1f9',
  integrity:
    'sha512-0V/HZDdWHcg6j0zVBzBsXcPZ571IVi6umKgTpnBhtTx/jm/LONmGF6cIWL2k4Xjyps0OiHV6B37nj2s0pUg0nQ==',
  repositoryUrl: 'https://github.com/modelcontextprotocol/conformance.git',
} as const);

export const MCP_LAB_SDK_SOURCE = Object.freeze({
  commitSha: 'cc4b41617ce3601b1290d67216ea0b194a3cd9ac',
  repositoryUrl: 'https://github.com/modelcontextprotocol/typescript-sdk.git',
  tag: `@modelcontextprotocol/server@${MCP_LAB_SDK_VERSION}`,
} as const);

export const MCP_LAB_SDK_SOURCE_SHA = MCP_LAB_SDK_SOURCE.commitSha;

export const MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE = Object.freeze({
  commitSha: MCP_LAB_SDK_SOURCE_SHA,
  kind: 'official-typescript-sdk',
  path: 'test/conformance/src/everythingServer.ts',
  repositoryUrl: MCP_LAB_SDK_SOURCE.repositoryUrl,
  sha256: '3a94417774fa20b17971e8162f9865b1cefd2650c7d88fdcd17f971d91213852',
} as const);

export const MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned-derived-profile',
  path: 'packages/mcp-test-lab/src/official-everything-profile.ts',
  sha256: OFFICIAL_EVERYTHING_PROFILE_SHA256,
  upstream: MCP_LAB_OFFICIAL_EVERYTHING_SERVER_SOURCE,
} as const);

/**
 * The pinned SDK v2 core carries only the older Tasks shape (`tasks/get`,
 * `tasks/cancel`, `notifications/tasks/status`; no `tasks/update`), so this is
 * PARTIAL upstream provenance for a Brainstrike-owned profile that implements
 * the 2026-07-28 revision; the evidence must not imply full upstream coverage.
 */
export const MCP_LAB_SDK_TASKS_SCHEMA_SOURCE = Object.freeze({
  commitSha: MCP_LAB_SDK_SOURCE_SHA,
  kind: 'official-typescript-sdk',
  path: 'packages/core/src/schemas.ts',
  repositoryUrl: MCP_LAB_SDK_SOURCE.repositoryUrl,
  sha256: '4d6cd50c55b1ee4f747f3a0fdd2b423d23f64c95fc5eb2afb4a197c9761d82e4',
} as const);

export const MCP_LAB_TASKS_PROFILE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned-derived-profile',
  path: 'packages/mcp-test-lab/src/tasks-profile.ts',
  sha256: TASKS_PROFILE_SHA256,
  upstream: MCP_LAB_SDK_TASKS_SCHEMA_SOURCE,
} as const);

/** Pinned official MCP Apps example server (lightweight tag; the tag IS the commit). */
export const MCP_LAB_EXT_APPS_SOURCE = Object.freeze({
  commitSha: '92f46a574568a3ddac7600343b7d3c4c4ed7b588',
  repositoryUrl: 'https://github.com/modelcontextprotocol/ext-apps.git',
  tag: 'v1.7.5',
} as const);

export const MCP_LAB_EXT_APPS_EXAMPLE_SERVER_SOURCE = Object.freeze({
  commitSha: MCP_LAB_EXT_APPS_SOURCE.commitSha,
  kind: 'official-ext-apps',
  path: 'examples/basic-server-vanillajs/server.ts',
  repositoryUrl: MCP_LAB_EXT_APPS_SOURCE.repositoryUrl,
  sha256: '6fb0ea689385cfb870563d5cfb06218712c62f74664278ca12b1905aa6169d8d',
} as const);

export const MCP_LAB_APPS_PROFILE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned-derived-profile',
  path: 'packages/mcp-test-lab/src/apps-profile.ts',
  sha256: APPS_PROFILE_SHA256,
  upstream: MCP_LAB_EXT_APPS_EXAMPLE_SERVER_SOURCE,
} as const);

const BRAINSTRIKE_HTTP_FIXTURE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned',
  path: 'packages/mcp-test-lab/src/reference-server.ts',
} as const);

const BRAINSTRIKE_OAUTH_FIXTURE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned',
  path: 'packages/mcp-test-lab/src/oauth-reference.ts',
} as const);

const BRAINSTRIKE_STDIO_FIXTURE_SOURCE = Object.freeze({
  kind: 'brainstrike-owned',
  path: 'packages/mcp-test-lab/fixtures/stdio-reference-server.mjs',
} as const);

export const MCP_LAB_SCENARIO_IDS = Object.freeze([
  'modern-reference',
  'legacy-reference',
  'stdio-reference',
  'oauth-reference',
  'tasks-reference',
  'apps-reference',
] as const);

export type McpLabScenarioId = (typeof MCP_LAB_SCENARIO_IDS)[number];

export type McpLabFixture =
  | 'brainstrike-apps-reference'
  | 'brainstrike-oauth-reference'
  | 'brainstrike-sdk-v2-reference'
  | 'brainstrike-stdio-reference'
  | 'brainstrike-tasks-reference'
  | 'official-sdk-v2-everything-reference';

export type McpLabFixtureSource =
  | typeof BRAINSTRIKE_HTTP_FIXTURE_SOURCE
  | typeof BRAINSTRIKE_OAUTH_FIXTURE_SOURCE
  | typeof BRAINSTRIKE_STDIO_FIXTURE_SOURCE
  | typeof MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE
  | typeof MCP_LAB_TASKS_PROFILE_SOURCE
  | typeof MCP_LAB_APPS_PROFILE_SOURCE;

export interface McpLabScenario {
  readonly authentication: 'none' | 'oauth';
  readonly availability: 'declared' | 'executable';
  readonly description: string;
  readonly fixture: McpLabFixture;
  readonly fixtureSource: McpLabFixtureSource;
  readonly id: McpLabScenarioId;
  readonly network: 'loopback-only';
  readonly protocol:
    | { readonly era: 'legacy'; readonly version: '2025-11-25' }
    | { readonly era: 'modern'; readonly version: '2026-07-28' };
  readonly reference: {
    readonly clientPackage: '@modelcontextprotocol/client';
    readonly conformancePackage: '@modelcontextprotocol/conformance';
    readonly conformanceSource: typeof MCP_LAB_CONFORMANCE_SOURCE;
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
  conformanceSource: MCP_LAB_CONFORMANCE_SOURCE,
  conformanceVersion: MCP_LAB_CONFORMANCE_VERSION,
  sdkSource: MCP_LAB_SDK_SOURCE,
  sdkSourceSha: MCP_LAB_SDK_SOURCE_SHA,
  sdkVersion: MCP_LAB_SDK_VERSION,
  serverPackage: '@modelcontextprotocol/server',
} as const);

function freezeScenario(scenario: McpLabScenario): McpLabScenario {
  return Object.freeze({
    ...scenario,
    fixtureSource: Object.freeze({ ...scenario.fixtureSource }),
    protocol: Object.freeze({ ...scenario.protocol }),
    reference: REFERENCE,
  });
}

const SCENARIOS: Readonly<Record<McpLabScenarioId, McpLabScenario>> = Object.freeze({
  'apps-reference': freezeScenario({
    authentication: 'none',
    availability: 'executable',
    description:
      'Executable modern MCP Apps reference derived from the pinned official ext-apps example server',
    fixture: 'brainstrike-apps-reference',
    fixtureSource: MCP_LAB_APPS_PROFILE_SOURCE,
    id: 'apps-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'legacy-reference': freezeScenario({
    authentication: 'none',
    availability: 'executable',
    description: 'Executable legacy-era reference over the Brainstrike-owned SDK v2 echo fixture',
    fixture: 'brainstrike-sdk-v2-reference',
    fixtureSource: BRAINSTRIKE_HTTP_FIXTURE_SOURCE,
    id: 'legacy-reference',
    network: 'loopback-only',
    protocol: { era: 'legacy', version: '2025-11-25' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'modern-reference': freezeScenario({
    authentication: 'none',
    availability: 'executable',
    description: 'Executable modern reference based on the official SDK v2 everything server',
    fixture: 'official-sdk-v2-everything-reference',
    fixtureSource: MCP_LAB_OFFICIAL_EVERYTHING_PROFILE_SOURCE,
    id: 'modern-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'oauth-reference': freezeScenario({
    authentication: 'oauth',
    availability: 'executable',
    description: 'Executable OAuth reference over a bearer-protected SDK v2 loopback fixture',
    fixture: 'brainstrike-oauth-reference',
    fixtureSource: BRAINSTRIKE_OAUTH_FIXTURE_SOURCE,
    id: 'oauth-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
    usesAmbientCredentials: false,
  }),
  'stdio-reference': freezeScenario({
    authentication: 'none',
    availability: 'executable',
    description: 'Executable modern reference over one lab-owned spawned stdio child',
    fixture: 'brainstrike-stdio-reference',
    fixtureSource: BRAINSTRIKE_STDIO_FIXTURE_SOURCE,
    id: 'stdio-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'stdio',
    usesAmbientCredentials: false,
  }),
  'tasks-reference': freezeScenario({
    authentication: 'none',
    availability: 'executable',
    description:
      'Executable modern Tasks-extension reference over the Brainstrike-owned schema-derived profile',
    fixture: 'brainstrike-tasks-reference',
    fixtureSource: MCP_LAB_TASKS_PROFILE_SOURCE,
    id: 'tasks-reference',
    network: 'loopback-only',
    protocol: { era: 'modern', version: '2026-07-28' },
    reference: REFERENCE,
    transport: 'streamable-http',
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
