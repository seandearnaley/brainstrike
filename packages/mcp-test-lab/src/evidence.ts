export const MCP_EVIDENCE_SCHEMA_VERSION = '1.0.0' as const;

const SDK_PACKAGE = '@modelcontextprotocol/client' as const;
const CONFORMANCE_PACKAGE = '@modelcontextprotocol/conformance' as const;

export type McpWorkspaceState = 'clean' | 'dirty';
export type McpCommandPhase = 'red' | 'green' | 'verification';
export type McpProtocolEra = 'legacy' | 'modern';
export type McpArtifactKind = 'log' | 'report' | 'screenshot' | 'trace';

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
  readonly tests: McpTestCounts;
}

export interface McpArtifactReference {
  readonly kind: McpArtifactKind;
  /** Repository-relative path below artifacts/. URLs and parent traversal are forbidden. */
  readonly reference: string;
  readonly sanitized: true;
  readonly sha256: string;
}

export interface McpEvidenceBlocker {
  readonly code: string;
  readonly description: string;
  readonly owner: string;
}

export interface McpEvidenceBundle {
  readonly artifacts: readonly McpArtifactReference[];
  /** An empty array is the explicit assertion that no blockers remain. */
  readonly blockers: readonly McpEvidenceBlocker[];
  readonly cleanup: {
    readonly command: string;
    readonly exitStatus: 0;
    readonly verified: true;
    readonly details: string;
  };
  readonly commands: readonly McpEvidenceCommand[];
  readonly correlationIds: readonly string[];
  readonly git: {
    readonly commitSha: string;
    readonly workspaceState: McpWorkspaceState;
  };
  readonly negotiation: {
    readonly era: McpProtocolEra;
    readonly revision: string;
    readonly capabilities: readonly string[];
  };
  readonly scenarioId: string;
  readonly schemaVersion: typeof MCP_EVIDENCE_SCHEMA_VERSION;
  readonly ticket: string;
  readonly versions: {
    readonly spec: string;
    readonly sdk: {
      readonly package: typeof SDK_PACKAGE;
      readonly version: string;
    };
    readonly conformance: {
      readonly package: typeof CONFORMANCE_PACKAGE;
      readonly version: string;
    };
  };
}

export type EvidenceSecretKind =
  | 'authorization-code'
  | 'bearer-token'
  | 'credential-bearing-url'
  | 'jwt'
  | 'pkce-verifier'
  | 'private-key';

export interface EvidenceSecretFinding {
  readonly index: number;
  readonly kind: EvidenceSecretKind;
}

export type McpEvidenceValidationCode =
  | 'invalid_value'
  | 'missing_field'
  | 'secret_detected'
  | 'unknown_field';

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

interface SecretPattern {
  readonly kind: EvidenceSecretKind;
  readonly pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'bearer-token',
    pattern: /\bbearer[ \t]+[a-z0-9._~+/-]{12,}={0,2}/gi,
  },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/gi,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
  },
];

const AUTH_MATERIAL_PATTERN =
  /\b(authorization[_ -]?code|auth[_ -]?code|code[_ -]?verifier|pkce[_ -]?verifier)\b[ \t]*[:=][ \t]*["']?[a-z0-9._~+/-]{8,}/gi;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'client_secret',
  'code',
  'code_verifier',
  'password',
  'refresh_token',
  'token',
]);

/**
 * Finds high-confidence credential material without retaining or returning the
 * matched secret. Findings are safe to include in validation diagnostics.
 */
export function scanEvidenceTextForSecrets(text: string): readonly EvidenceSecretFinding[] {
  const findings: EvidenceSecretFinding[] = [];

  for (const secretPattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(secretPattern.pattern)) {
      findings.push({ index: match.index, kind: secretPattern.kind });
    }
  }

  for (const match of text.matchAll(AUTH_MATERIAL_PATTERN)) {
    const label = match[1]?.toLowerCase() ?? '';
    findings.push({
      index: match.index,
      kind: label.includes('verifier') ? 'pkce-verifier' : 'authorization-code',
    });
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrlPunctuation(match[0]);
    if (!hasEmbeddedUrlCredential(candidate)) {
      continue;
    }
    findings.push({ index: match.index, kind: 'credential-bearing-url' });
  }

  return findings.sort(
    (left, right) => left.index - right.index || left.kind.localeCompare(right.kind)
  );
}

/**
 * Parses unknown input into the immutable evidence contract. Every object is
 * closed: missing and unknown fields fail instead of being defaulted or stripped.
 */
export function parseMcpEvidenceBundle(input: unknown): McpEvidenceBundle {
  const root = strictObject(input, '$', [
    'schemaVersion',
    'ticket',
    'git',
    'versions',
    'scenarioId',
    'commands',
    'negotiation',
    'correlationIds',
    'artifacts',
    'cleanup',
    'blockers',
  ]);

  const bundle: McpEvidenceBundle = {
    artifacts: parseArtifacts(root['artifacts']),
    blockers: parseBlockers(root['blockers']),
    cleanup: parseCleanup(root['cleanup']),
    commands: parseCommands(root['commands']),
    correlationIds: parseCorrelationIds(root['correlationIds']),
    git: parseGit(root['git']),
    negotiation: parseNegotiation(root['negotiation']),
    scenarioId: matchingString(
      root['scenarioId'],
      '$.scenarioId',
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'lowercase scenario id'
    ),
    schemaVersion: exactLiteral(
      root['schemaVersion'],
      MCP_EVIDENCE_SCHEMA_VERSION,
      '$.schemaVersion'
    ),
    ticket: matchingString(root['ticket'], '$.ticket', /^BST-[1-9]\d*$/, 'BST ticket'),
    versions: parseVersions(root['versions']),
  };

  assertProofOrder(bundle.commands);
  assertSanitizedText(bundle, '$');
  return bundle;
}

function parseGit(input: unknown): McpEvidenceBundle['git'] {
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

function parseVersions(input: unknown): McpEvidenceBundle['versions'] {
  const value = strictObject(input, '$.versions', ['spec', 'sdk', 'conformance']);
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
      version: exactSemanticVersion(conformance['version'], '$.versions.conformance.version'),
    },
    sdk: {
      package: exactLiteral(sdk['package'], SDK_PACKAGE, '$.versions.sdk.package'),
      version: exactSemanticVersion(sdk['version'], '$.versions.sdk.version'),
    },
    spec: protocolRevision(value['spec'], '$.versions.spec'),
  };
}

function parseCommands(input: unknown): readonly McpEvidenceCommand[] {
  const commands = nonEmptyArray(input, '$.commands');
  return commands.map((entry, index) => {
    const path = `$.commands[${index}]`;
    const value = strictObject(entry, path, ['phase', 'command', 'exitStatus', 'tests']);
    return {
      command: nonEmptyString(value['command'], `${path}.command`),
      exitStatus: integerInRange(value['exitStatus'], `${path}.exitStatus`, 0, 255),
      phase: oneOf(value['phase'], `${path}.phase`, ['red', 'green', 'verification']),
      tests: parseTestCounts(value['tests'], `${path}.tests`),
    };
  });
}

function parseTestCounts(input: unknown, path: string): McpTestCounts {
  const value = strictObject(input, path, ['passed', 'failed', 'skipped', 'total']);
  const counts: McpTestCounts = {
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

function parseNegotiation(input: unknown): McpEvidenceBundle['negotiation'] {
  const value = strictObject(input, '$.negotiation', ['era', 'revision', 'capabilities']);
  const capabilities = nonEmptyArray(value['capabilities'], '$.negotiation.capabilities').map(
    (capability, index) =>
      matchingString(
        capability,
        `$.negotiation.capabilities[${index}]`,
        /^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/,
        'capability identifier'
      )
  );
  assertUnique(capabilities, '$.negotiation.capabilities');

  return {
    capabilities,
    era: oneOf(value['era'], '$.negotiation.era', ['legacy', 'modern']),
    revision: protocolRevision(value['revision'], '$.negotiation.revision'),
  };
}

function parseCorrelationIds(input: unknown): readonly string[] {
  const values = nonEmptyArray(input, '$.correlationIds').map((entry, index) =>
    matchingString(
      entry,
      `$.correlationIds[${index}]`,
      /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/,
      '8-128 character correlation id'
    )
  );
  assertUnique(values, '$.correlationIds');
  return values;
}

function parseArtifacts(input: unknown): readonly McpArtifactReference[] {
  const artifacts = arrayValue(input, '$.artifacts');
  return artifacts.map((entry, index) => {
    const path = `$.artifacts[${index}]`;
    const value = strictObject(entry, path, ['kind', 'reference', 'sha256', 'sanitized']);
    return {
      kind: oneOf(value['kind'], `${path}.kind`, ['log', 'report', 'screenshot', 'trace']),
      reference: artifactReference(value['reference'], `${path}.reference`),
      sanitized: exactLiteral(value['sanitized'], true, `${path}.sanitized`),
      sha256: matchingString(
        value['sha256'],
        `${path}.sha256`,
        /^[0-9a-f]{64}$/,
        'lowercase SHA-256 digest'
      ),
    };
  });
}

function parseCleanup(input: unknown): McpEvidenceBundle['cleanup'] {
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

  let greenObserved = false;
  for (const [index, command] of commands.entries()) {
    greenObserved = validateProofCommand(command, index, greenObserved);
  }

  if (!greenObserved) {
    invalid('$.commands', 'at least one successful GREEN proof is required');
  }
}

function validateProofCommand(
  command: McpEvidenceCommand,
  index: number,
  greenObserved: boolean
): boolean {
  const path = `$.commands[${index}]`;
  if (command.phase === 'red') {
    validateRedProof(command, path, greenObserved);
    return false;
  }
  if (command.phase === 'green') {
    validateGreenProof(command, path);
    return true;
  }
  validateVerificationProof(command, path, greenObserved);
  return greenObserved;
}

function validateRedProof(command: McpEvidenceCommand, path: string, greenObserved: boolean): void {
  if (greenObserved) {
    invalid(path, 'RED proof cannot appear after GREEN proof');
  }
  if (command.exitStatus === 0) {
    invalid(`${path}.exitStatus`, 'RED proof must have a non-zero exit status');
  }
}

function validateGreenProof(command: McpEvidenceCommand, path: string): void {
  if (command.exitStatus !== 0 || command.tests.failed !== 0 || command.tests.passed === 0) {
    invalid(
      path,
      'GREEN proof must have zero exit status, zero failed tests, and at least one passed test'
    );
  }
}

function validateVerificationProof(
  command: McpEvidenceCommand,
  path: string,
  greenObserved: boolean
): void {
  if (!greenObserved) {
    invalid(path, 'verification commands require prior GREEN proof');
  }
  if (command.exitStatus !== 0 || command.tests.failed !== 0) {
    invalid(path, 'verification command must have zero exit status and zero failed tests');
  }
}

function assertSanitizedText(value: unknown, path: string): void {
  if (typeof value === 'string') {
    const finding = scanEvidenceTextForSecrets(value)[0];
    if (finding) {
      fail(path, 'secret_detected', `contains prohibited ${finding.kind} material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertSanitizedText(entry, `${path}[${index}]`);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertSanitizedText(entry, path === '$' ? `$.${key}` : `${path}.${key}`);
  }
}

function strictObject(
  input: unknown,
  path: string,
  requiredKeys: readonly string[]
): Record<string, unknown> {
  if (!isRecord(input)) {
    invalid(path, 'must be an object');
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(input, key)) {
      fail(`${path}.${key}`, 'missing_field', 'required field is missing');
    }
  }
  const allowed = new Set(requiredKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, 'unknown_field', 'unknown field is not allowed');
    }
  }
  return input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
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
  pattern: RegExp,
  description: string
): string {
  const value = nonEmptyString(input, path);
  if (!pattern.test(value)) {
    invalid(path, `must be an exact ${description}`);
  }
  return value;
}

function exactSemanticVersion(input: unknown, path: string): string {
  return matchingString(
    input,
    path,
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
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
    !value.startsWith('artifacts/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    invalid(path, 'must be a repository-relative path below artifacts/ without traversal');
  }
  return value;
}

function arrayValue(input: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    invalid(path, 'must be an array');
  }
  return input;
}

function nonEmptyArray(input: unknown, path: string): readonly unknown[] {
  const value = arrayValue(input, path);
  if (value.length === 0) {
    invalid(path, 'must be a non-empty array');
  }
  return value;
}

function nonNegativeInteger(input: unknown, path: string): number {
  return integerInRange(input, path, 0, Number.MAX_SAFE_INTEGER);
}

function integerInRange(input: unknown, path: string, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(input) ||
    typeof input !== 'number' ||
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
  if (!match) {
    invalid(path, `must be one of: ${values.join(', ')}`);
  }
  return match;
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    invalid(path, 'values must be unique');
  }
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;\]}]+$/g, '');
}

function hasEmbeddedUrlCredential(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return true;
  }
  for (const [key, value] of url.searchParams) {
    if (value.length > 0 && CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function invalid(path: string, message: string): never {
  fail(path, 'invalid_value', message);
}

function fail(path: string, code: McpEvidenceValidationCode, message: string): never {
  throw new McpEvidenceValidationError({ code, message, path });
}
