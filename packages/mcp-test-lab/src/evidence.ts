import { createHash } from 'node:crypto';

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
  readonly proofId: string;
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
  | 'basic-credential'
  | 'bearer-token'
  | 'credential-assignment'
  | 'credential-bearing-url'
  | 'jwt'
  | 'pkce-verifier'
  | 'private-key';

export interface EvidenceSecretFinding {
  readonly index: number;
  readonly kind: EvidenceSecretKind;
}

export interface McpArtifactReadResult {
  readonly bytes: Uint8Array;
}

export interface McpEvidenceValidationDependencies {
  readonly extractScreenshotText?: (bytes: Uint8Array, reference: string) => string;
  readonly readArtifactContent: (reference: string) => McpArtifactReadResult;
}

export type McpEvidenceValidationCode =
  | 'invalid_value'
  | 'missing_field'
  | 'secret_detected'
  | 'unknown_field';

export interface McpEvidenceValidationIssue {
  readonly code: McpEvidenceValidationCode;
  readonly index?: number;
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
    kind: 'basic-credential',
    pattern: /\bauthorization["']?[ \t]*[:=][ \t]*["']?basic[ \t]+[a-z0-9+/]+={0,2}/gi,
  },
  {
    kind: 'bearer-token',
    pattern: /\bbearer[ \t]+[a-z0-9._~+/-]+={0,2}/gi,
  },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/gi,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[a-z0-9_-]{6,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi,
  },
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const CREDENTIAL_KEYS = [
  'access_token',
  'api_key',
  'auth_code',
  'authorization',
  'authorization_code',
  'client_secret',
  'code',
  'code_verifier',
  'password',
  'pkce_verifier',
  'refresh_token',
  'token',
] as const;
const CREDENTIAL_KEY_SET = new Set<string>(CREDENTIAL_KEYS);
const GENERIC_CREDENTIAL_KEYS = new Set(['authorization', 'code', 'token']);
const MAX_SERIALIZED_JSON_SCAN_DEPTH = 4;
const CREDENTIAL_ASSIGNMENT_KEYS = CREDENTIAL_KEYS.map((key) => key.replaceAll('_', '[_ -]'));
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${CREDENTIAL_ASSIGNMENT_KEYS.join('|')})\\b["']?[ \\t]*[:=][ \\t]*["']?[^\\s"',;&?#}\\]]+`,
  'gi'
);

/**
 * Finds high-confidence credential material without retaining or returning the
 * matched secret. Findings are safe to include in validation diagnostics.
 */
export function scanEvidenceTextForSecrets(text: string): readonly EvidenceSecretFinding[] {
  const findings: EvidenceSecretFinding[] = [];
  const urlRanges: { readonly end: number; readonly start: number }[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = trimUrlPunctuation(match[0]);
    urlRanges.push({ end: match.index + candidate.length, start: match.index });
    if (hasEmbeddedUrlCredential(candidate)) {
      findings.push({ index: match.index, kind: 'credential-bearing-url' });
    }
  }

  for (const secretPattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(secretPattern.pattern)) {
      findings.push({ index: match.index, kind: secretPattern.kind });
    }
  }

  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT_PATTERN)) {
    if (urlRanges.some((range) => match.index >= range.start && match.index < range.end)) {
      continue;
    }
    const label = match[1]?.toLowerCase().replaceAll(/[ -]/g, '_') ?? '';
    const separatorIndex = match[0].search(/[:=]/u);
    const assignedValue =
      separatorIndex === -1
        ? ''
        : match[0]
            .slice(separatorIndex + 1)
            .trim()
            .replace(/^["']/u, '');
    const prefix = text.slice(Math.max(0, match.index - 16), match.index);
    if (
      GENERIC_CREDENTIAL_KEYS.has(label) &&
      isSafeDiagnosticAssignment(label, assignedValue, prefix)
    ) {
      continue;
    }
    findings.push({
      index: match.index,
      kind: credentialAssignmentKind(label),
    });
  }

  return findings.sort(
    (left, right) => left.index - right.index || left.kind.localeCompare(right.kind)
  );
}

function isSafeDiagnosticAssignment(label: string, value: string, prefix: string): boolean {
  if (/^(?:disabled|none|redacted)$/iu.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^not[-_ ]required(?:[-_ ].*)?$/iu.test(value)) {
    return true;
  }
  if (label === 'authorization' && /^(?:basic|bearer)$/iu.test(value)) {
    return true;
  }
  return (
    label === 'code' && /(?:error|exit)[ \t]+$/iu.test(prefix) && /^[A-Z][A-Z0-9_]*$/u.test(value)
  );
}

/**
 * Parses unknown input into the immutable evidence contract. Every object is
 * closed: missing and unknown fields fail instead of being defaulted or stripped.
 */
export function parseMcpEvidenceBundle(
  input: unknown,
  dependencies: McpEvidenceValidationDependencies
): McpEvidenceBundle {
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
  assertSanitizedArtifacts(bundle.artifacts, dependencies);
  return deepFreeze(bundle);
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
  const era = oneOf(value['era'], '$.negotiation.era', ['legacy', 'modern']);
  const revision = protocolRevision(value['revision'], '$.negotiation.revision');
  const expectedRevision = era === 'legacy' ? '2025-11-25' : '2026-07-28';
  if (revision !== expectedRevision) {
    invalid(
      '$.negotiation',
      `era "${era}" requires revision "${expectedRevision}", received "${revision}"`
    );
  }

  return {
    capabilities,
    era,
    revision,
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
  const parsed = artifacts.map((entry, index) => {
    const path = `$.artifacts[${index}]`;
    const value = strictObject(entry, path, ['kind', 'reference', 'sha256', 'sanitized']);
    const kind = oneOf(value['kind'], `${path}.kind`, ['log', 'report', 'screenshot', 'trace']);
    const reference = artifactReference(value['reference'], `${path}.reference`);
    assertArtifactKindMatchesReference(kind, reference, path);
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
    parsed.map((artifact) => artifact.reference),
    '$.artifact references'
  );
  return parsed;
}

const ARTIFACT_EXTENSIONS: Readonly<Record<McpArtifactKind, ReadonlySet<string>>> = {
  log: new Set(['.json', '.log', '.ndjson', '.txt']),
  report: new Set(['.html', '.json', '.md', '.txt']),
  screenshot: new Set(['.jpeg', '.jpg', '.png', '.webp']),
  trace: new Set(['.json', '.ndjson', '.trace']),
};

function assertArtifactKindMatchesReference(
  kind: McpArtifactKind,
  reference: string,
  path: string
): void {
  const filename = reference.split('/').at(-1) ?? '';
  const extensionIndex = filename.lastIndexOf('.');
  const extension = extensionIndex === -1 ? '' : filename.slice(extensionIndex).toLowerCase();
  if (!ARTIFACT_EXTENSIONS[kind].has(extension)) {
    invalid(
      `${path}.reference`,
      `extension "${extension || '(none)'}" is incompatible with artifact kind "${kind}"`
    );
  }
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

  const pendingRed = new Set<string>();
  const completedGreen = new Set<string>();
  for (const [index, command] of commands.entries()) {
    validateProofCommand(command, index, pendingRed, completedGreen);
  }

  if (completedGreen.size === 0) {
    invalid('$.commands', 'at least one successful GREEN proof is required');
  }
  if (pendingRed.size > 0) {
    invalid('$.commands', `RED proof is missing GREEN proof for: ${[...pendingRed].join(', ')}`);
  }
}

function validateProofCommand(
  command: McpEvidenceCommand,
  index: number,
  pendingRed: Set<string>,
  completedGreen: Set<string>
): void {
  const path = `$.commands[${index}]`;
  if (command.phase === 'red') {
    validateRedProof(command, path);
    if (pendingRed.has(command.proofId) || completedGreen.has(command.proofId)) {
      invalid(`${path}.proofId`, 'RED proof id must be unique');
    }
    pendingRed.add(command.proofId);
    return;
  }
  if (command.phase === 'green') {
    validateGreenProof(command, path);
    if (!pendingRed.delete(command.proofId)) {
      invalid(`${path}.proofId`, 'GREEN proof requires a matching prior RED proof');
    }
    completedGreen.add(command.proofId);
    return;
  }
  validateVerificationProof(command, path, completedGreen.has(command.proofId));
}

function validateRedProof(command: McpEvidenceCommand, path: string): void {
  if (command.exitStatus === 0) {
    invalid(`${path}.exitStatus`, 'RED proof must have a non-zero exit status');
  }
  if (command.tests.failed < 1) {
    invalid(path, 'RED proof must report at least one failed test');
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
  matchingGreenObserved: boolean
): void {
  if (!matchingGreenObserved) {
    invalid(path, 'verification commands require prior GREEN proof with the same proof id');
  }
  if (command.exitStatus !== 0 || command.tests.failed !== 0) {
    invalid(path, 'verification command must have zero exit status and zero failed tests');
  }
}

function assertSerializedJsonText(value: string, path: string, serializedJsonDepth: number): void {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return;
  }
  if (serializedJsonDepth >= MAX_SERIALIZED_JSON_SCAN_DEPTH) {
    invalid(path, 'serialized JSON nesting exceeds the evidence scan limit');
  }
  assertSanitizedText(parsed, `${path}.serializedJson`, true, serializedJsonDepth + 1);
}

function assertSanitizedText(
  value: unknown,
  path: string,
  scanDecodedKeys = false,
  serializedJsonDepth = 0
): void {
  if (typeof value === 'string') {
    const finding = scanEvidenceTextForSecrets(value)[0];
    if (finding) {
      fail(path, 'secret_detected', `contains prohibited ${finding.kind} material`, finding.index);
    }
    if (scanDecodedKeys) {
      assertSerializedJsonText(value, path, serializedJsonDepth);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertSanitizedText(entry, `${path}[${index}]`, scanDecodedKeys, serializedJsonDepth);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path === '$' ? `$.${key}` : `${path}.${key}`;
    const normalizedKey = key.toLowerCase().replaceAll(/[ -]/g, '_');
    if (scanDecodedKeys && typeof entry === 'string' && CREDENTIAL_KEY_SET.has(normalizedKey)) {
      const finding = scanEvidenceTextForSecrets(`${normalizedKey}=${entry}`)[0];
      if (finding) {
        fail(
          entryPath,
          'secret_detected',
          `contains prohibited ${finding.kind} material`,
          finding.index
        );
      }
    }
    assertSanitizedText(entry, entryPath, scanDecodedKeys, serializedJsonDepth);
  }
}

function assertSanitizedArtifacts(
  artifacts: readonly McpArtifactReference[],
  dependencies: McpEvidenceValidationDependencies
): void {
  for (const [index, artifact] of artifacts.entries()) {
    let result: McpArtifactReadResult;
    try {
      result = dependencies.readArtifactContent(artifact.reference);
    } catch {
      invalid(`$.artifacts[${index}].reference`, 'referenced artifact content could not be read');
    }
    if (!(result.bytes instanceof Uint8Array)) {
      invalid(`$.artifacts[${index}].content`, 'artifact reader must return exact bytes');
    }
    const bytes = Uint8Array.from(result.bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifact.sha256) {
      invalid(`$.artifacts[${index}].sha256`, 'does not match referenced artifact content');
    }
    assertSanitizedArtifactBytes(artifact, bytes, dependencies, `$.artifacts[${index}].content`);
  }
}

function assertSanitizedArtifactBytes(
  artifact: McpArtifactReference,
  bytes: Uint8Array,
  dependencies: McpEvidenceValidationDependencies,
  path: string
): void {
  if (artifact.kind === 'screenshot') {
    if (!dependencies.extractScreenshotText) {
      invalid(path, 'screenshot evidence requires exact-byte text extraction');
    }
    let extractedText: string;
    try {
      extractedText = dependencies.extractScreenshotText(
        Uint8Array.from(bytes),
        artifact.reference
      );
    } catch {
      invalid(path, 'screenshot text extraction failed');
    }
    if (typeof extractedText !== 'string') {
      invalid(path, 'screenshot text extraction must return a string');
    }
    assertSanitizedText(extractedText, path);
    assertSanitizedParsedJson(extractedText, path);
    return;
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    invalid(path, `${artifact.kind} evidence must contain valid UTF-8 text`);
  }
  assertSanitizedText(text, path);
  assertSanitizedParsedJson(text, path);
}

function assertSanitizedParsedJson(text: string, path: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    assertSanitizedText(JSON.parse(trimmed) as unknown, path, true);
    return;
  } catch (error) {
    if (error instanceof McpEvidenceValidationError) {
      throw error;
    }
  }

  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const candidate = line.trim();
    if (!(candidate.startsWith('{') || candidate.startsWith('['))) {
      continue;
    }
    try {
      assertSanitizedText(JSON.parse(candidate) as unknown, `${path}.ndjson[${index}]`, true);
    } catch (error) {
      if (error instanceof McpEvidenceValidationError) {
        throw error;
      }
    }
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

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    return Object.freeze(value) as T;
  }
  return value;
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
  return (
    hasCredentialParameter(url.searchParams) || hasCredentialParameter(fragmentParameters(url.hash))
  );
}

function fragmentParameters(hash: string): URLSearchParams {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = fragment.indexOf('?');
  return new URLSearchParams(queryIndex === -1 ? fragment : fragment.slice(queryIndex + 1));
}

function hasCredentialParameter(parameters: URLSearchParams): boolean {
  for (const [key, value] of parameters) {
    const normalizedKey = key.toLowerCase().replaceAll(/[ -]/g, '_');
    if (value.length > 0 && CREDENTIAL_KEY_SET.has(normalizedKey)) {
      return true;
    }
  }
  return false;
}

function credentialAssignmentKind(label: string): EvidenceSecretKind {
  if (label.includes('verifier')) {
    return 'pkce-verifier';
  }
  if (label === 'code' || label.endsWith('_code')) {
    return 'authorization-code';
  }
  return 'credential-assignment';
}

function invalid(path: string, message: string): never {
  fail(path, 'invalid_value', message);
}

function fail(
  path: string,
  code: McpEvidenceValidationCode,
  message: string,
  index?: number
): never {
  throw new McpEvidenceValidationError({
    code,
    message,
    path,
    ...(index === undefined ? {} : { index }),
  });
}
