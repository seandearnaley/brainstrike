export const OFFICIAL_AUTH_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2026-07-28'] as const);

export type OfficialAuthProtocolVersion = (typeof OFFICIAL_AUTH_PROTOCOL_VERSIONS)[number];

export const OFFICIAL_CORE_LEGACY_SCENARIOS = Object.freeze([
  'initialize',
  'tools_call',
  'elicitation-sep1034-client-defaults',
  'sse-retry',
] as const);

export const OFFICIAL_CORE_MODERN_SCENARIOS = Object.freeze([
  'tools_call',
  'request-metadata',
  'sep-2322-client-request-state',
  'http-standard-headers',
  'http-custom-headers',
  'http-invalid-tool-headers',
  'json-schema-ref-no-deref',
] as const);

export type OfficialCoreScenarioName =
  | (typeof OFFICIAL_CORE_LEGACY_SCENARIOS)[number]
  | (typeof OFFICIAL_CORE_MODERN_SCENARIOS)[number];

export const OFFICIAL_CORE_SCENARIOS_BY_PROTOCOL = Object.freeze({
  '2025-11-25': OFFICIAL_CORE_LEGACY_SCENARIOS,
  '2026-07-28': OFFICIAL_CORE_MODERN_SCENARIOS,
} satisfies Readonly<Record<OfficialAuthProtocolVersion, readonly OfficialCoreScenarioName[]>>);

export const OFFICIAL_AUTH_BASELINE_SCENARIOS = Object.freeze([
  'auth/metadata-default',
  'auth/metadata-var1',
  'auth/metadata-var2',
  'auth/metadata-var3',
  'auth/basic-cimd',
  'auth/scope-from-www-authenticate',
  'auth/scope-from-scopes-supported',
  'auth/scope-omitted-when-undefined',
  'auth/scope-step-up',
  'auth/scope-retry-limit',
  'auth/token-endpoint-auth-basic',
  'auth/token-endpoint-auth-post',
  'auth/token-endpoint-auth-none',
  'auth/pre-registration',
] as const);

export const OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS = Object.freeze([
  'auth/resource-mismatch',
  'auth/offline-access-scope',
  'auth/offline-access-not-supported',
  'auth/authorization-server-migration',
  'auth/iss-supported',
  'auth/iss-not-advertised',
  'auth/iss-supported-missing',
  'auth/iss-wrong-issuer',
  'auth/iss-unexpected',
  'auth/iss-normalized',
  'auth/metadata-issuer-mismatch',
] as const);

export const OFFICIAL_AUTH_SCENARIOS = Object.freeze([
  ...OFFICIAL_AUTH_BASELINE_SCENARIOS,
  ...OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS,
] as const);

export type OfficialAuthScenarioName = (typeof OFFICIAL_AUTH_SCENARIOS)[number];
type OfficialConformanceScenarioName = OfficialAuthScenarioName | OfficialCoreScenarioName;

export const OFFICIAL_AUTH_SCENARIOS_BY_PROTOCOL = Object.freeze({
  '2025-11-25': OFFICIAL_AUTH_BASELINE_SCENARIOS,
  '2026-07-28': OFFICIAL_AUTH_SCENARIOS,
} satisfies Readonly<Record<OfficialAuthProtocolVersion, readonly OfficialAuthScenarioName[]>>);

interface OfficialAuthConformanceProfileDescriptor {
  readonly buildTimeoutMinutes: number;
  readonly cleanupScope: 'auth' | 'core';
  readonly displayName: string;
  readonly evidencePath: string;
  readonly evidenceProfile: boolean;
  readonly execution: 'parallel-by-protocol' | 'sequential';
  readonly jobTimeoutMinutes: number;
  readonly provisionTimeoutMinutes: number;
  readonly runnerOverheadMs: number;
  readonly scenarioDeadlineMs: number;
  readonly scenariosByProtocol: Readonly<
    Partial<Record<OfficialAuthProtocolVersion, readonly OfficialConformanceScenarioName[]>>
  >;
  readonly schemaVersion: '1.0.0' | '1.1.0';
  readonly stepTimeoutMinutes: number;
  readonly ticket: 'BST-1560' | 'BST-1576' | 'BST-1583';
  readonly workflowOverheadMinutes: number;
}

const SCENARIO_DEADLINE_MS = 45_000;

export const OFFICIAL_AUTH_CONFORMANCE_PROFILES = Object.freeze({
  baseline: Object.freeze({
    buildTimeoutMinutes: 4,
    cleanupScope: 'auth',
    displayName: 'auth',
    evidencePath: 'packages/mcp-test-lab/artifacts/official-auth-evidence.json',
    evidenceProfile: false,
    execution: 'parallel-by-protocol',
    jobTimeoutMinutes: 11,
    provisionTimeoutMinutes: 3,
    runnerOverheadMs: 60_000,
    scenarioDeadlineMs: SCENARIO_DEADLINE_MS,
    scenariosByProtocol: Object.freeze({
      '2025-11-25': OFFICIAL_AUTH_BASELINE_SCENARIOS,
      '2026-07-28': OFFICIAL_AUTH_BASELINE_SCENARIOS,
    }),
    schemaVersion: '1.0.0',
    stepTimeoutMinutes: 3,
    ticket: 'BST-1560',
    workflowOverheadMinutes: 1,
  }),
  core: Object.freeze({
    buildTimeoutMinutes: 4,
    cleanupScope: 'core',
    displayName: 'core',
    evidencePath: 'packages/mcp-test-lab/artifacts/official-core-evidence.json',
    evidenceProfile: true,
    execution: 'parallel-by-protocol',
    jobTimeoutMinutes: 11,
    provisionTimeoutMinutes: 3,
    runnerOverheadMs: 60_000,
    scenarioDeadlineMs: SCENARIO_DEADLINE_MS,
    scenariosByProtocol: OFFICIAL_CORE_SCENARIOS_BY_PROTOCOL,
    schemaVersion: '1.1.0',
    stepTimeoutMinutes: 3,
    ticket: 'BST-1583',
    workflowOverheadMinutes: 1,
  }),
  'modern-closeout': Object.freeze({
    buildTimeoutMinutes: 4,
    cleanupScope: 'auth',
    displayName: 'modern auth closeout',
    evidencePath: 'packages/mcp-test-lab/artifacts/official-auth-modern-closeout-evidence.json',
    evidenceProfile: true,
    execution: 'sequential',
    jobTimeoutMinutes: 21,
    provisionTimeoutMinutes: 3,
    runnerOverheadMs: 60_000,
    scenarioDeadlineMs: SCENARIO_DEADLINE_MS,
    scenariosByProtocol: Object.freeze({
      '2026-07-28': OFFICIAL_AUTH_MODERN_CLOSEOUT_SCENARIOS,
    }),
    schemaVersion: '1.1.0',
    stepTimeoutMinutes: 10,
    ticket: 'BST-1576',
    workflowOverheadMinutes: 4,
  }),
} satisfies Readonly<Record<string, OfficialAuthConformanceProfileDescriptor>>);

export type OfficialAuthConformanceProfile = keyof typeof OFFICIAL_AUTH_CONFORMANCE_PROFILES;
