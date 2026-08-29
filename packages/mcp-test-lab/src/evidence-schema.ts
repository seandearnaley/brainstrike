import { isMcpLabCorrelationId } from './faults.js';

export const MCP_EVIDENCE_SCHEMA_VERSION = '1.0.0' as const;
const SDK_PACKAGE = '@modelcontextprotocol/client' as const;
const CONFORMANCE_PACKAGE = '@modelcontextprotocol/conformance' as const;
const MAX_EVIDENCE_ARRAY_ITEMS = 1000;
export type McpCommandPhase = 'green' | 'red' | 'verification';
export type McpProtocolEra = 'legacy' | 'modern';
export type McpArtifactKind = 'log' | 'report' | 'screenshot' | 'trace';
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
  readonly git: {
    readonly commitSha: string;
    readonly workspaceState: 'clean' | 'dirty';
  };
  readonly negotiation: {
    readonly capabilities: readonly string[];
    readonly era: McpProtocolEra;
    readonly revision: string;
  };
  readonly scenarioId: string;
  readonly schemaVersion: typeof MCP_EVIDENCE_SCHEMA_VERSION;
  readonly ticket: string;
  readonly versions: {
    readonly conformance: {
      readonly package: typeof CONFORMANCE_PACKAGE;
      readonly version: string;
    };
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
    'artifacts',
    'cleanup',
    'blockers',
  ]);
  const schema: McpEvidenceSchema = {
    artifacts: parseArtifacts(root['artifacts']),
    blockers: parseBlockers(root['blockers']),
    cleanup: parseCleanup(root['cleanup']),
    commands: parseCommands(root['commands']),
    correlationIds: parseUniqueStrings(
      root['correlationIds'],
      '$.correlationIds',
      isMcpLabCorrelationId,
      'bounded MCP lab correlation id'
    ),
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
  if (schema.versions.spec !== schema.negotiation.revision) {
    invalid(
      '$.versions.spec',
      `must equal $.negotiation.revision "${schema.negotiation.revision}"`
    );
  }
  assertProofOrder(schema.commands);
  return schema;
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
      version: semanticVersion(conformance['version'], '$.versions.conformance.version'),
    },
    sdk: {
      package: exactLiteral(sdk['package'], SDK_PACKAGE, '$.versions.sdk.package'),
      version: semanticVersion(sdk['version'], '$.versions.sdk.version'),
    },
    spec: protocolRevision(value['spec'], '$.versions.spec'),
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
