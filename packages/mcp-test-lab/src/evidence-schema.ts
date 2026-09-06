import { isMcpLabCorrelationId } from './faults.js';
import {
  getMcpLabScenario,
  MCP_LAB_SCENARIO_IDS,
  type McpLabFixture,
  type McpLabScenarioId,
} from './scenario.js';

export const MCP_EVIDENCE_SCHEMA_VERSION = '1.1.0' as const;
const SDK_PACKAGE = '@modelcontextprotocol/client' as const;
const CONFORMANCE_PACKAGE = '@modelcontextprotocol/conformance' as const;
const MAX_EVIDENCE_ARRAY_ITEMS = 1000;
const MCP_EVIDENCE_FIXTURE_IDS = Object.freeze([
  'brainstrike-apps-reference',
  'brainstrike-oauth-reference',
  'brainstrike-sdk-v2-reference',
  'brainstrike-stdio-reference',
  'brainstrike-tasks-reference',
  'official-sdk-v2-everything-reference',
] as const satisfies readonly McpLabFixture[]);
export type McpCommandPhase = 'green' | 'red' | 'verification';
export type McpProtocolEra = 'legacy' | 'modern';
export type McpArtifactKind = 'log' | 'report' | 'screenshot' | 'trace';
export const MCP_DESKTOP_MANUAL_SCENARIO_IDS = Object.freeze([
  'settings-connect',
  'oauth-browser-return',
  'assistant-call',
  'cancellation',
  'restart-reconnect',
  'config-change',
  'concurrent-runs',
  'disconnect-cleanup',
] as const);
export type McpDesktopManualScenarioId = (typeof MCP_DESKTOP_MANUAL_SCENARIO_IDS)[number];
const REVISION_BY_ERA: Readonly<Record<McpProtocolEra, string>> = {
  legacy: '2025-11-25',
  modern: '2026-07-28',
};
export interface McpTestCounts {
  readonly failed: number;
  readonly passed: number;
  readonly skipped: number;
  readonly total: number;
}
export interface McpEvidenceCommand {
  readonly command: string;
  readonly exitStatus: number;
  readonly phase: McpCommandPhase;
  readonly proofId: string;
  readonly tests: McpTestCounts;
}
export interface McpArtifactReference {
  readonly kind: McpArtifactKind;
  readonly reference: string;
  readonly sanitized: true;
  readonly sha256: string;
}
export interface McpEvidenceBlocker {
  readonly code: string;
  readonly description: string;
  readonly owner: string;
}
export const MCP_EVIDENCE_UPSTREAM_KINDS = Object.freeze([
  'official-ext-apps',
  'official-typescript-sdk',
] as const);
export type McpEvidenceUpstreamKind = (typeof MCP_EVIDENCE_UPSTREAM_KINDS)[number];
export type McpEvidenceFixtureVersion =
  | {
      readonly id: McpLabFixture;
      readonly kind: 'brainstrike-owned';
      readonly path: string;
    }
  | {
      readonly id: McpLabFixture;
      readonly kind: 'brainstrike-owned-derived-profile';
      readonly path: string;
      readonly sha256: string;
      readonly upstream: {
        readonly commitSha: string;
        readonly kind: McpEvidenceUpstreamKind;
        readonly path: string;
        readonly repositoryUrl: string;
        readonly sha256: string;
      };
    };
export interface McpDesktopManualScenarioEvidence {
  readonly artifactReferences: readonly string[];
  readonly blockerCode: string | null;
  readonly id: McpDesktopManualScenarioId;
  readonly status: 'blocked' | 'passed';
}
export type McpDesktopEvidence =
  | {
      readonly reason: 'protocol-lab-only';
      readonly required: false;
    }
  | {
      readonly app: {
        readonly bundleId: 'com.brainstrike.desktop.agent-debug';
        readonly title: 'BrainStrike Agent Debug';
      };
      readonly cdt: {
        readonly endpoint: string;
        readonly inspected: true;
        readonly rendererUrl: string;
        readonly targetTitle: 'BrainStrike Agent Debug';
      };
      readonly electronE2e: {
        readonly command: string;
        readonly exitStatus: 0;
        readonly tests: McpTestCounts;
      };
      readonly matrix: readonly McpDesktopManualScenarioEvidence[];
      readonly profile: {
        readonly isolated: true;
        readonly userDataDirectory: string;
      };
      readonly required: true;
      readonly secretScan: {
        readonly artifactReferences: readonly string[];
        readonly command: string;
        readonly exitStatus: 0;
        readonly verified: true;
      };
    };
export interface McpEvidenceSchema {
  readonly artifacts: readonly McpArtifactReference[];
  readonly blockers: readonly McpEvidenceBlocker[];
  readonly cleanup: {
    readonly command: string;
    readonly details: string;
    readonly exitStatus: 0;
    readonly verified: true;
  };
  readonly commands: readonly McpEvidenceCommand[];
  readonly correlationIds: readonly string[];
  readonly desktop: McpDesktopEvidence;
  readonly git: {
    readonly commitSha: string;
    readonly workspaceState: 'clean' | 'dirty';
  };
  readonly negotiation: {
    readonly capabilities: readonly string[];
    readonly era: McpProtocolEra;
    readonly revision: string;
  };
  readonly scenarioId: McpLabScenarioId;
  readonly schemaVersion: typeof MCP_EVIDENCE_SCHEMA_VERSION;
  readonly ticket: string;
  readonly versions: {
    readonly conformance: {
      readonly package: typeof CONFORMANCE_PACKAGE;
      readonly version: string;
    };
    readonly fixture: McpEvidenceFixtureVersion;
    readonly sdk: {
      readonly package: typeof SDK_PACKAGE;
      readonly version: string;
    };
    readonly spec: string;
  };
}
export type McpEvidenceValidationCode = 'invalid_value' | 'missing_field' | 'unknown_field';
export interface McpEvidenceValidationIssue {
  readonly code: McpEvidenceValidationCode;
  readonly message: string;
  readonly path: string;
}
export class McpEvidenceValidationError extends Error {
  readonly issue: McpEvidenceValidationIssue;
  constructor(issue: McpEvidenceValidationIssue) {
    super(`${issue.path}: ${issue.message}`);
    this.name = 'McpEvidenceValidationError';
    this.issue = issue;
  }
}
export function parseMcpEvidenceSchema(input: unknown): McpEvidenceSchema {
  const root = strictObject(input, '$', [
    'schemaVersion',
    'ticket',
    'git',
    'versions',
    'scenarioId',
    'commands',
    'negotiation',
    'correlationIds',
    'desktop',
    'artifacts',
    'cleanup',
    'blockers',
  ]);
  const artifacts = parseArtifacts(root['artifacts']);
  const blockers = parseBlockers(root['blockers']);
  const schema: McpEvidenceSchema = {
    artifacts,
    blockers,
    cleanup: parseCleanup(root['cleanup']),
    commands: parseCommands(root['commands']),
    correlationIds: parseUniqueStrings(
      root['correlationIds'],
      '$.correlationIds',
      isMcpLabCorrelationId,
      'bounded MCP lab correlation id'
    ),
    desktop: parseDesktopEvidence(root['desktop'], artifacts, blockers),
    git: parseGit(root['git']),
    negotiation: parseNegotiation(root['negotiation']),
    scenarioId: oneOf(root['scenarioId'], '$.scenarioId', MCP_LAB_SCENARIO_IDS),
    schemaVersion: exactLiteral(
      root['schemaVersion'],
      MCP_EVIDENCE_SCHEMA_VERSION,
      '$.schemaVersion'
    ),
    ticket: matchingString(root['ticket'], '$.ticket', /^BST-[1-9]\d*$/, 'BST ticket'),
    versions: parseVersions(root['versions']),
  };
  if (schema.versions.spec !== schema.negotiation.revision) {
    invalid(
      '$.versions.spec',
      `must equal $.negotiation.revision "${schema.negotiation.revision}"`
    );
  }
  assertCanonicalScenarioClaims(schema);
  assertProofOrder(schema.commands);
  return schema;
}
function parseDesktopEvidence(
  input: unknown,
  artifacts: readonly McpArtifactReference[],
  blockers: readonly McpEvidenceBlocker[]
): McpDesktopEvidence {
  if (!(isRecord(input) && Object.hasOwn(input, 'required'))) {
    if (!isRecord(input)) {
      invalid('$.desktop', 'must be a plain object');
    }
    fail('$.desktop.required', 'missing_field', 'required field is missing');
  }
  let required: unknown;
  try {
    required = input['required'];
  } catch {
    invalid('$.desktop.required', 'could not snapshot field');
  }
  if (required === false) {
    const value = strictObject(input, '$.desktop', ['required', 'reason']);
    return {
      reason: exactLiteral(value['reason'], 'protocol-lab-only', '$.desktop.reason'),
      required: false,
    };
  }
  if (required !== true) {
    invalid('$.desktop.required', 'must be a boolean');
  }
  const value = strictObject(input, '$.desktop', [
    'required',
    'app',
    'profile',
    'electronE2e',
    'cdt',
    'matrix',
    'secretScan',
  ]);
  const app = strictObject(value['app'], '$.desktop.app', ['bundleId', 'title']);
  const profile = strictObject(value['profile'], '$.desktop.profile', [
    'isolated',
    'userDataDirectory',
  ]);
  const electronE2e = strictObject(value['electronE2e'], '$.desktop.electronE2e', [
    'command',
    'exitStatus',
    'tests',
  ]);
  const e2eTests = parseTestCounts(electronE2e['tests'], '$.desktop.electronE2e.tests');
  if (e2eTests.failed !== 0 || e2eTests.passed < 1) {
    invalid('$.desktop.electronE2e.tests', 'requires zero failures and at least one passed test');
  }
  const cdt = strictObject(value['cdt'], '$.desktop.cdt', [
    'endpoint',
    'inspected',
    'rendererUrl',
    'targetTitle',
  ]);
  if (!artifacts.some(({ kind }) => kind === 'screenshot')) {
    invalid('$.desktop', 'requires at least one reviewable screenshot artifact');
  }
  if (!artifacts.some(({ kind }) => kind === 'log' || kind === 'trace')) {
    invalid('$.desktop', 'requires at least one durable log or trace artifact');
  }
  const artifactReferences = artifacts.map(({ reference }) => reference);
  const blockerCodes = blockers.map(({ code }) => code);
  const matrix = parseDesktopMatrix(value['matrix'], artifactReferences, blockerCodes);
  const secretScan = strictObject(value['secretScan'], '$.desktop.secretScan', [
    'command',
    'exitStatus',
    'verified',
    'artifactReferences',
  ]);
  const scannedReferences = parseUniqueStrings(
    secretScan['artifactReferences'],
    '$.desktop.secretScan.artifactReferences',
    (entry) => artifactReferences.includes(entry),
    'declared artifact reference'
  );
  if (!sameStringSet(scannedReferences, artifactReferences)) {
    invalid(
      '$.desktop.secretScan.artifactReferences',
      'must cover every declared artifact exactly once'
    );
  }
  return {
    app: {
      bundleId: exactLiteral(
        app['bundleId'],
        'com.brainstrike.desktop.agent-debug',
        '$.desktop.app.bundleId'
      ),
      title: exactLiteral(app['title'], 'BrainStrike Agent Debug', '$.desktop.app.title'),
    },
    cdt: {
      endpoint: cdtEndpoint(cdt['endpoint'], '$.desktop.cdt.endpoint'),
      inspected: exactLiteral(cdt['inspected'], true, '$.desktop.cdt.inspected'),
      rendererUrl: desktopRendererUrl(cdt['rendererUrl'], '$.desktop.cdt.rendererUrl'),
      targetTitle: exactLiteral(
        cdt['targetTitle'],
        'BrainStrike Agent Debug',
        '$.desktop.cdt.targetTitle'
      ),
    },
    electronE2e: {
      command: nonEmptyString(electronE2e['command'], '$.desktop.electronE2e.command'),
      exitStatus: exactLiteral(electronE2e['exitStatus'], 0, '$.desktop.electronE2e.exitStatus'),
      tests: e2eTests,
    },
    matrix,
    profile: {
      isolated: exactLiteral(profile['isolated'], true, '$.desktop.profile.isolated'),
      userDataDirectory: nonEmptyString(
        profile['userDataDirectory'],
        '$.desktop.profile.userDataDirectory'
      ),
    },
    required: true,
    secretScan: {
      artifactReferences: scannedReferences,
      command: nonEmptyString(secretScan['command'], '$.desktop.secretScan.command'),
      exitStatus: exactLiteral(secretScan['exitStatus'], 0, '$.desktop.secretScan.exitStatus'),
      verified: exactLiteral(secretScan['verified'], true, '$.desktop.secretScan.verified'),
    },
  };
}

function parseDesktopMatrix(
  input: unknown,
  artifactReferences: readonly string[],
  blockerCodes: readonly string[]
): readonly McpDesktopManualScenarioEvidence[] {
  const entries = nonEmptyArray(input, '$.desktop.matrix').map((entry, index) => {
    const path = `$.desktop.matrix[${index}]`;
    const value = strictObject(entry, path, ['id', 'status', 'artifactReferences', 'blockerCode']);
    const id = oneOf(value['id'], `${path}.id`, MCP_DESKTOP_MANUAL_SCENARIO_IDS);
    const status = oneOf(value['status'], `${path}.status`, ['passed', 'blocked']);
    const references = parseUniqueStrings(
      nonEmptyArray(value['artifactReferences'], `${path}.artifactReferences`),
      `${path}.artifactReferences`,
      (reference) => artifactReferences.includes(reference),
      'declared artifact reference'
    );
    const blockerCode =
      value['blockerCode'] === null
        ? null
        : matchingString(
            value['blockerCode'],
            `${path}.blockerCode`,
            /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
            'lowercase blocker code'
          );
    if (status === 'passed' && blockerCode !== null) {
      invalid(`${path}.blockerCode`, 'must be null for a passed scenario');
    }
    if (status === 'blocked' && (blockerCode === null || !blockerCodes.includes(blockerCode))) {
      invalid(`${path}.blockerCode`, 'must name a declared blocker for a blocked scenario');
    }
    return { artifactReferences: references, blockerCode, id, status };
  });
  const ids = entries.map(({ id }) => id);
  assertUnique(ids, '$.desktop.matrix');
  if (!sameStringSet(ids, MCP_DESKTOP_MANUAL_SCENARIO_IDS)) {
    invalid('$.desktop.matrix', 'must contain the complete prescribed desktop scenario matrix');
  }
  return entries;
}

function cdtEndpoint(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(path, 'must be an HTTP loopback CDT origin');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    invalid(path, 'must be an HTTP 127.0.0.1 CDT origin with an explicit port');
  }
  return value;
}

/**
 * The capabilities each fixture negotiates, keyed by FIXTURE rather than
 * scenario: the fixture's registrations are what the SDK infers capabilities
 * from, and two scenarios (legacy + OAuth) share the Brainstrike echo server.
 * Since BST-1592 that server also registers one resource and one completable
 * prompt, so it advertises `completions`/`prompts`/`resources`; the spawned
 * stdio fixture is a separate echo-only server and still advertises `tools`.
 */
const CAPABILITIES_BY_FIXTURE: Readonly<Record<McpLabFixture, readonly string[]>> = Object.freeze({
  'brainstrike-apps-reference': ['resources', 'tools'],
  'brainstrike-oauth-reference': ['completions', 'prompts', 'resources', 'tools'],
  'brainstrike-sdk-v2-reference': ['completions', 'prompts', 'resources', 'tools'],
  'brainstrike-stdio-reference': ['tools'],
  'brainstrike-tasks-reference': ['extensions', 'tools'],
  'official-sdk-v2-everything-reference': ['completions', 'prompts', 'resources', 'tools'],
});

/**
 * The capabilities a scenario's fixture must negotiate. Exported so the live
 * runner integration test and the synthetic runner fixtures assert against ONE
 * map rather than three copies of the same ternary.
 */
export function mcpEvidenceCapabilitiesFor(scenarioId: McpLabScenarioId): readonly string[] {
  return CAPABILITIES_BY_FIXTURE[getMcpLabScenario(scenarioId).fixture];
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}
function assertCanonicalScenarioClaims(schema: McpEvidenceSchema): void {
  const scenario = getMcpLabScenario(schema.scenarioId);
  const expectedCapabilities = mcpEvidenceCapabilitiesFor(schema.scenarioId);
  if (
    schema.versions.spec !== scenario.protocol.version ||
    schema.versions.sdk.version !== scenario.reference.sdkVersion ||
    schema.versions.conformance.version !== scenario.reference.conformanceVersion ||
    schema.negotiation.era !== scenario.protocol.era ||
    schema.negotiation.revision !== scenario.protocol.version ||
    !sameStringSet(schema.negotiation.capabilities, expectedCapabilities)
  ) {
    invalid('$', `evidence claims do not match scenario "${schema.scenarioId}"`);
  }
  const expectedFixture = { id: scenario.fixture, ...scenario.fixtureSource };
  if (JSON.stringify(schema.versions.fixture) !== JSON.stringify(expectedFixture)) {
    invalid('$.versions.fixture', `must match scenario "${schema.scenarioId}" provenance`);
  }
}
function parseGit(input: unknown): McpEvidenceSchema['git'] {
  const value = strictObject(input, '$.git', ['commitSha', 'workspaceState']);
  return {
    commitSha: matchingString(
      value['commitSha'],
      '$.git.commitSha',
      /^[0-9a-f]{40}$/,
      'full lowercase 40-character commit SHA'
    ),
    workspaceState: oneOf(value['workspaceState'], '$.git.workspaceState', ['clean', 'dirty']),
  };
}
function parseVersions(input: unknown): McpEvidenceSchema['versions'] {
  const value = strictObject(input, '$.versions', ['spec', 'sdk', 'conformance', 'fixture']);
  const sdk = strictObject(value['sdk'], '$.versions.sdk', ['package', 'version']);
  const conformance = strictObject(value['conformance'], '$.versions.conformance', [
    'package',
    'version',
  ]);
  return {
    conformance: {
      package: exactLiteral(
        conformance['package'],
        CONFORMANCE_PACKAGE,
        '$.versions.conformance.package'
      ),
      version: semanticVersion(conformance['version'], '$.versions.conformance.version'),
    },
    fixture: parseFixtureVersion(value['fixture']),
    sdk: {
      package: exactLiteral(sdk['package'], SDK_PACKAGE, '$.versions.sdk.package'),
      version: semanticVersion(sdk['version'], '$.versions.sdk.version'),
    },
    spec: protocolRevision(value['spec'], '$.versions.spec'),
  };
}
function parseFixtureVersion(input: unknown): McpEvidenceFixtureVersion {
  if (!(isRecord(input) && Object.hasOwn(input, 'kind'))) {
    if (!isRecord(input)) {
      invalid('$.versions.fixture', 'must be a plain object');
    }
    fail('$.versions.fixture.kind', 'missing_field', 'required field is missing');
  }
  let kind: unknown;
  try {
    kind = input['kind'];
  } catch {
    invalid('$.versions.fixture.kind', 'could not snapshot field');
  }
  if (kind === 'brainstrike-owned') {
    const value = strictObject(input, '$.versions.fixture', ['kind', 'id', 'path']);
    return {
      id: oneOf(value['id'], '$.versions.fixture.id', MCP_EVIDENCE_FIXTURE_IDS),
      kind,
      path: repositoryPath(value['path'], '$.versions.fixture.path'),
    };
  }
  if (kind !== 'brainstrike-owned-derived-profile') {
    invalid(
      '$.versions.fixture.kind',
      'must be "brainstrike-owned" or "brainstrike-owned-derived-profile"'
    );
  }
  const value = strictObject(input, '$.versions.fixture', [
    'kind',
    'id',
    'path',
    'sha256',
    'upstream',
  ]);
  const upstream = strictObject(value['upstream'], '$.versions.fixture.upstream', [
    'kind',
    'path',
    'repositoryUrl',
    'commitSha',
    'sha256',
  ]);
  return {
    id: oneOf(value['id'], '$.versions.fixture.id', MCP_EVIDENCE_FIXTURE_IDS),
    kind,
    path: repositoryPath(value['path'], '$.versions.fixture.path'),
    sha256: matchingString(
      value['sha256'],
      '$.versions.fixture.sha256',
      /^[0-9a-f]{64}$/,
      'lowercase SHA-256 digest'
    ),
    upstream: {
      commitSha: matchingString(
        upstream['commitSha'],
        '$.versions.fixture.upstream.commitSha',
        /^[0-9a-f]{40}$/,
        'full lowercase 40-character commit SHA'
      ),
      kind: oneOf(
        upstream['kind'],
        '$.versions.fixture.upstream.kind',
        MCP_EVIDENCE_UPSTREAM_KINDS
      ),
      path: repositoryPath(upstream['path'], '$.versions.fixture.upstream.path'),
      repositoryUrl: repositoryUrl(
        upstream['repositoryUrl'],
        '$.versions.fixture.upstream.repositoryUrl'
      ),
      sha256: matchingString(
        upstream['sha256'],
        '$.versions.fixture.upstream.sha256',
        /^[0-9a-f]{64}$/,
        'lowercase SHA-256 digest'
      ),
    },
  };
}
function parseCommands(input: unknown): readonly McpEvidenceCommand[] {
  return nonEmptyArray(input, '$.commands').map((entry, index) => {
    const path = `$.commands[${index}]`;
    const value = strictObject(entry, path, ['phase', 'proofId', 'command', 'exitStatus', 'tests']);
    return {
      command: nonEmptyString(value['command'], `${path}.command`),
      exitStatus: integerInRange(value['exitStatus'], `${path}.exitStatus`, 0, 255),
      phase: oneOf(value['phase'], `${path}.phase`, ['red', 'green', 'verification']),
      proofId: matchingString(
        value['proofId'],
        `${path}.proofId`,
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'lowercase proof id'
      ),
      tests: parseTestCounts(value['tests'], `${path}.tests`),
    };
  });
}
function parseTestCounts(input: unknown, path: string): McpTestCounts {
  const value = strictObject(input, path, ['passed', 'failed', 'skipped', 'total']);
  const counts = {
    failed: nonNegativeInteger(value['failed'], `${path}.failed`),
    passed: nonNegativeInteger(value['passed'], `${path}.passed`),
    skipped: nonNegativeInteger(value['skipped'], `${path}.skipped`),
    total: nonNegativeInteger(value['total'], `${path}.total`),
  };
  if (counts.total !== counts.passed + counts.failed + counts.skipped) {
    invalid(`${path}.total`, 'must equal passed + failed + skipped');
  }
  return counts;
}
function parseNegotiation(input: unknown): McpEvidenceSchema['negotiation'] {
  const value = strictObject(input, '$.negotiation', ['era', 'revision', 'capabilities']);
  const capabilities = parseUniqueStrings(
    value['capabilities'],
    '$.negotiation.capabilities',
    /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/,
    'capability identifier'
  );
  const era = oneOf(value['era'], '$.negotiation.era', ['legacy', 'modern']);
  const revision = protocolRevision(value['revision'], '$.negotiation.revision');
  const expected = REVISION_BY_ERA[era];
  if (revision !== expected) {
    invalid('$.negotiation', `era "${era}" requires revision "${expected}"`);
  }
  return { capabilities, era, revision };
}
function parseArtifacts(input: unknown): readonly McpArtifactReference[] {
  const artifacts = arrayValue(input, '$.artifacts').map((entry, index) => {
    const path = `$.artifacts[${index}]`;
    const value = strictObject(entry, path, ['kind', 'reference', 'sha256', 'sanitized']);
    const kind = oneOf(value['kind'], `${path}.kind`, ['log', 'report', 'screenshot', 'trace']);
    const reference = artifactReference(value['reference'], `${path}.reference`);
    assertArtifactExtension(kind, reference, path);
    return {
      kind,
      reference,
      sanitized: exactLiteral(value['sanitized'], true, `${path}.sanitized`),
      sha256: matchingString(
        value['sha256'],
        `${path}.sha256`,
        /^[0-9a-f]{64}$/,
        'lowercase SHA-256 digest'
      ),
    };
  });
  assertUnique(
    artifacts.map((artifact) => artifact.reference),
    '$.artifacts'
  );
  return artifacts;
}
const ARTIFACT_EXTENSIONS: Readonly<Record<McpArtifactKind, ReadonlySet<string>>> = {
  log: new Set(['.json', '.log', '.ndjson', '.txt']),
  report: new Set(['.html', '.json', '.md', '.txt']),
  screenshot: new Set(['.jpeg', '.jpg', '.png', '.webp']),
  trace: new Set(['.json', '.ndjson', '.trace']),
};
function assertArtifactExtension(kind: McpArtifactKind, reference: string, path: string): void {
  const filename = reference.split('/').at(-1) ?? '';
  const dot = filename.lastIndexOf('.');
  const extension = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  if (!ARTIFACT_EXTENSIONS[kind].has(extension)) {
    invalid(`${path}.reference`, `extension is incompatible with artifact kind "${kind}"`);
  }
}
function parseCleanup(input: unknown): McpEvidenceSchema['cleanup'] {
  const value = strictObject(input, '$.cleanup', ['command', 'exitStatus', 'verified', 'details']);
  return {
    command: nonEmptyString(value['command'], '$.cleanup.command'),
    details: nonEmptyString(value['details'], '$.cleanup.details'),
    exitStatus: exactLiteral(value['exitStatus'], 0, '$.cleanup.exitStatus'),
    verified: exactLiteral(value['verified'], true, '$.cleanup.verified'),
  };
}
function parseBlockers(input: unknown): readonly McpEvidenceBlocker[] {
  return arrayValue(input, '$.blockers').map((entry, index) => {
    const path = `$.blockers[${index}]`;
    const value = strictObject(entry, path, ['code', 'description', 'owner']);
    return {
      code: matchingString(
        value['code'],
        `${path}.code`,
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'lowercase blocker code'
      ),
      description: nonEmptyString(value['description'], `${path}.description`),
      owner: nonEmptyString(value['owner'], `${path}.owner`),
    };
  });
}
function assertProofOrder(commands: readonly McpEvidenceCommand[]): void {
  if (commands[0]?.phase !== 'red') {
    invalid('$.commands', 'RED proof must be first');
  }
  const pending = new Map<string, string>();
  const green = new Map<string, string>();
  for (const [index, command] of commands.entries()) {
    validateProofCommand(command, index, pending, green);
  }
  if (green.size === 0) {
    invalid('$.commands', 'at least one successful GREEN proof is required');
  }
  if (pending.size > 0) {
    invalid(
      '$.commands',
      `RED proof is missing GREEN proof for: ${[...pending.keys()].join(', ')}`
    );
  }
}
function validateProofCommand(
  command: McpEvidenceCommand,
  index: number,
  pending: Map<string, string>,
  green: Map<string, string>
): void {
  const path = `$.commands[${index}]`;
  if (command.phase === 'red') {
    validateRedProof(command, path, pending, green);
    return;
  }
  if (command.phase === 'green') {
    validateGreenProof(command, path, pending, green);
    return;
  }
  const greenCommand = green.get(command.proofId);
  if (greenCommand === undefined) {
    invalid(path, 'verification requires prior GREEN proof with the same proof id');
  }
  if (command.command !== greenCommand) {
    invalid(`${path}.command`, 'verification must run the same command as its GREEN proof');
  }
  if (command.exitStatus !== 0 || command.tests.failed !== 0 || command.tests.passed < 1) {
    invalid(path, 'verification requires success, zero failures, and at least one passed test');
  }
}
function validateRedProof(
  command: McpEvidenceCommand,
  path: string,
  pending: Map<string, string>,
  green: Map<string, string>
): void {
  if (command.exitStatus === 0 || command.tests.failed < 1) {
    invalid(path, 'RED proof requires a non-zero exit status and at least one failed test');
  }
  if (pending.has(command.proofId) || green.has(command.proofId)) {
    invalid(`${path}.proofId`, 'RED proof id must be unique');
  }
  pending.set(command.proofId, command.command);
}
function validateGreenProof(
  command: McpEvidenceCommand,
  path: string,
  pending: Map<string, string>,
  green: Map<string, string>
): void {
  const redCommand = pending.get(command.proofId);
  if (redCommand === undefined) {
    invalid(`${path}.proofId`, 'GREEN proof requires a matching prior RED proof');
  }
  if (redCommand !== command.command) {
    invalid(`${path}.command`, 'GREEN proof must run the same command as its matching RED proof');
  }
  if (command.exitStatus !== 0 || command.tests.failed !== 0 || command.tests.passed < 1) {
    invalid(path, 'GREEN proof requires success, zero failures, and at least one passed test');
  }
  pending.delete(command.proofId);
  green.set(command.proofId, command.command);
}
function strictObject(
  input: unknown,
  path: string,
  requiredKeys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(input)) {
    invalid(path, 'must be a plain object');
  }
  const allowed = new Set(requiredKeys);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(`${path}.${String(key)}`, 'unknown_field', 'unknown field is not allowed');
    }
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      fail(`${path}.${key}`, 'missing_field', 'required field is missing');
    }
    try {
      snapshot[key] = input[key];
    } catch {
      invalid(`${path}.${key}`, 'could not snapshot field');
    }
  }
  return snapshot;
}
function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
function arrayValue(input: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    invalid(path, 'must be an array');
  }
  let length: number;
  try {
    length = input.length;
  } catch {
    invalid(path, 'could not snapshot array length');
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_EVIDENCE_ARRAY_ITEMS) {
    invalid(path, `must contain at most ${MAX_EVIDENCE_ARRAY_ITEMS} items`);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let present: boolean;
    try {
      present = Object.hasOwn(input, index);
    } catch {
      invalid(`${path}[${index}]`, 'could not inspect array entry');
    }
    if (!present) {
      invalid(`${path}[${index}]`, 'sparse arrays are not allowed');
    }
    try {
      snapshot.push(input[index]);
    } catch {
      invalid(`${path}[${index}]`, 'could not snapshot array entry');
    }
  }
  return snapshot;
}
function nonEmptyArray(input: unknown, path: string): readonly unknown[] {
  const value = arrayValue(input, path);
  if (value.length === 0) {
    invalid(path, 'must be a non-empty array');
  }
  return value;
}
function parseUniqueStrings(
  input: unknown,
  path: string,
  matcher: RegExp | ((value: string) => boolean),
  description: string
): readonly string[] {
  const values = nonEmptyArray(input, path).map((entry, index) =>
    matchingString(entry, `${path}[${index}]`, matcher, description)
  );
  assertUnique(values, path);
  return values;
}
function nonEmptyString(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    invalid(path, 'must be a non-empty string without surrounding whitespace');
  }
  return input;
}
function matchingString(
  input: unknown,
  path: string,
  matcher: RegExp | ((value: string) => boolean),
  description: string
): string {
  const value = nonEmptyString(input, path);
  if (!(matcher instanceof RegExp ? matcher.test(value) : matcher(value))) {
    invalid(path, `must be an exact ${description}`);
  }
  return value;
}
function semanticVersion(input: unknown, path: string): string {
  return matchingString(
    input,
    path,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'semantic version without a range or tag'
  );
}
function protocolRevision(input: unknown, path: string): string {
  const value = matchingString(input, path, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD revision');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    invalid(path, 'must be a real calendar date');
  }
  return value;
}
function artifactReference(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (
    value.length > 512 ||
    !/^[\x20-\x7e]+$/.test(value) ||
    !value.startsWith('artifacts/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    invalid(path, 'must be a repository-relative path below artifacts without traversal');
  }
  return value;
}
function repositoryPath(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (
    value.length > 512 ||
    !/^[\x20-\x7e]+$/.test(value) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    invalid(path, 'must be a repository-relative path without traversal');
  }
  return value;
}
function repositoryUrl(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(path, 'must be an HTTPS Git repository URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.pathname.endsWith('.git')
  ) {
    invalid(path, 'must be an HTTPS Git repository URL without credentials or parameters');
  }
  return value;
}
function desktopRendererUrl(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(path, 'must be an HTTP(S) loopback renderer URL with an explicit port');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    invalid(
      path,
      'must be an HTTP(S) loopback renderer URL with an explicit port and no credentials'
    );
  }
  return value;
}
function nonNegativeInteger(input: unknown, path: string): number {
  return integerInRange(input, path, 0, Number.MAX_SAFE_INTEGER);
}
function integerInRange(input: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof input !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    invalid(path, `must be an integer from ${minimum} through ${maximum}`);
  }
  return input;
}
function exactLiteral<const T extends string | number | boolean>(
  input: unknown,
  expected: T,
  path: string
): T {
  if (input !== expected) {
    invalid(path, `must equal ${JSON.stringify(expected)}`);
  }
  return expected;
}
function oneOf<const T extends string>(input: unknown, path: string, values: readonly T[]): T {
  if (typeof input !== 'string') {
    invalid(path, `must be one of: ${values.join(', ')}`);
  }
  const match = values.find((value) => value === input);
  if (match === undefined) {
    invalid(path, `must be one of: ${values.join(', ')}`);
  }
  return match;
}
function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    invalid(path, 'values must be unique');
  }
}
function invalid(path: string, message: string): never {
  fail(path, 'invalid_value', message);
}
function fail(path: string, code: McpEvidenceValidationCode, message: string): never {
  throw new McpEvidenceValidationError({ code, message, path });
}
