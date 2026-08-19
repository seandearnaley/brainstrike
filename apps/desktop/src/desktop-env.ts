import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_ENV_FILE_LABELS } from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import {
  listProviders,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_ENV_KEYS } from './tavily-env-keys';

export type DesktopEnvFile = 'dev' | 'dev-local' | 'user-data';

export interface DesktopEnvLoadFailure {
  readonly code: 'env_file_invalid' | 'env_file_unreadable';
  readonly file: DesktopEnvFile;
  readonly message: string;
}

export interface DesktopEnvLoadResult {
  readonly appliedVariableCount: number;
  /**
   * Deprecated provider env NAMES present in the loaded files (BST-1361) —
   * names only, never values. Presence in a file is what matters: a name the
   * inherited process env shadows is still listed, because the user's file
   * still spells the retired name and deserves the rename warning.
   * CONSUMER: BST-1363 (env bootstrap visibility) — file-scoped provenance
   * ("your .env spells a retired name") is a better repair signal for that
   * UI than the process-wide detector, which cannot say where a value came
   * from.
   */
  readonly deprecatedVariableNames: readonly string[];
  readonly failures: readonly DesktopEnvLoadFailure[];
  readonly loadedFiles: readonly DesktopEnvFile[];
  readonly skipped: boolean;
}

export interface LoadDesktopEnvironmentOptions {
  readonly appRoot: string;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly userDataPath: string;
}

interface DesktopEnvCandidate {
  readonly file: DesktopEnvFile;
  readonly path: string;
}

interface ParsedDesktopEnvCandidate {
  readonly entries: ReadonlyMap<string, string>;
  readonly file: DesktopEnvFile;
}

class DesktopEnvParseError extends Error {
  readonly line: number;

  constructor(line: number, reason: string) {
    super(reason);
    this.name = 'DesktopEnvParseError';
    this.line = line;
  }
}

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Registry-derived credential names a `.env` FILE may set (BST-1361, split in
 * BST-1350). Deprecated names stay here forever: an unrecognized name rejects
 * the WHOLE file, so dropping them would brick existing user files.
 *
 * Derived from the shared provider registry plus the Tavily names rather than
 * hand-copied — a hand-written list silently drifts.
 *
 * This set is FILE-LOADABILITY ONLY. The child-process scrub is driven by
 * {@link SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES}, which is a strict superset;
 * see the security note there for why the two roles cannot share one constant.
 */
export const CREDENTIAL_ENV_FILE_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...listProviders().flatMap((definition) => [
    ...providerEnvKeys(definition.id),
    ...providerDeprecatedEnvKeys(definition.id),
  ]),
  ...TAVILY_ENV_KEYS,
]);

/**
 * Credential names ambient in the process environment that are NOT
 * `.env`-file loadable (PR #2525 review, finding 1). Scrub-only.
 *
 * AWS static credentials arrive from the user's SHELL, not from our env
 * files: BST-1353 documents `AWS_ACCESS_KEY_ID` as one of the names that
 * ACTIVATES the credential chain, so they are routinely present in a real
 * desktop process env. They must never become file-settable (that would hand
 * a `<userData>/.env` write a brand-new credential channel), but they
 * absolutely must be scrubbed from child environments.
 */
const AMBIENT_ONLY_CREDENTIAL_ENV_VARIABLE_NAMES: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

/**
 * NOTE on the BST-1363 env-bootstrap report (`desktop-env-report.ts`): it
 * reports `credentialVariablesPresent` from the FILE set and
 * `nonCredentialVariablesPresent` from the non-credential set, so these
 * ambient-only names appear in NEITHER chip list. That is consistent — that
 * report describes the `.env` ALLOW-LIST, and these names are not
 * file-loadable — and it is not a leak either way, since the report carries
 * NAMES only, never values. If a later ticket wants "AWS_ACCESS_KEY_ID is
 * activating your Bedrock chain" surfaced in that UI, the fix is to read
 * {@link SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES} for the CREDENTIAL chip list
 * — never to move these names into the non-credential set, which would both
 * unscrub them and paint them as innocuous config.
 */

/**
 * CHILD-ENV SCRUB set — names repository-controlled children must never
 * inherit (the main-process env reaches children; non-interactive command,
 * skill, and hook children strip these, while interactive PTYs and
 * runtime-support children intentionally retain the parent env).
 *
 * SECURITY — WHY THIS IS SEPARATE FROM THE FILE SET (PR #2525 review,
 * finding 1). `createCredentialIsolatedChildEnvironment` is a DENY-LIST: it
 * copies every name that is NOT in this set. So "absent from every set" does
 * not mean "protected" — it means "passed through VERBATIM". A credential
 * that is ambient-but-not-file-loadable therefore needs explicit membership
 * HERE, and the earlier reasoning that omitting AWS static keys from both
 * sets was safe had the deny-list backwards.
 *
 * INVARIANT: this set is a strict superset of
 * {@link CREDENTIAL_ENV_FILE_VARIABLE_NAMES} — anything a file may set is by
 * definition credential-shaped enough to scrub. Pinned by desktop-env.test.ts.
 * When adding a credential name, ask which role it plays: file-loadable ⇒ the
 * file set (which flows in here automatically); ambient-only ⇒ the list above.
 */
export const SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...CREDENTIAL_ENV_FILE_VARIABLE_NAMES,
  ...AMBIENT_ONLY_CREDENTIAL_ENV_VARIABLE_NAMES,
]);

/**
 * Deliberate NON-credential supported names (BST-1350). These are `.env`-file
 * loadable configuration, NOT secrets — they stay OUT of the child-env
 * credential scrub (a child may legitimately need the region), but remain
 * inside the strict allow-list boundary below. Extend deliberately; anything
 * credential-shaped belongs in the registry-derived set instead.
 *
 * - `AWS_REGION`: the region an env-resolved Bedrock bearer key pairs with
 *   (stored credentials carry their own region).
 * - `AWS_PROFILE` (BST-1353): NAMES a profile in the user's `~/.aws/config`;
 *   it holds no secret, exactly like `AWS_REGION`. The credentials it points
 *   AT are secret, but they live in the user's AWS configuration and never
 *   pass through this process's environment — so scrubbing the name from
 *   child environments would break `aws` CLI children while protecting
 *   nothing. It is also a chain ACTIVATION name (see
 *   AWS_CHAIN_ACTIVATION_ENV_NAMES).
 *
 * MEMBERSHIP HERE IS A SECURITY CLASSIFICATION, not a convenience list, and
 * it is load-bearing in two places at once: this set is EXCLUDED from the
 * child-process credential scrub, and BST-1363 renders it to the user as
 * muted "config" chips (while credential names render as credential chips).
 * So a secret placed here would BOTH leak into repository-controlled child
 * processes AND be painted as innocuous.
 *
 * `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_SESSION_TOKEN` are
 * real secrets and therefore live in
 * {@link SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES}, not here — they are scrubbed
 * from children while remaining un-settable from a `.env` file.
 */
export const NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES: ReadonlySet<string> =
  new Set<string>(['AWS_PROFILE', 'AWS_REGION']);

/**
 * `.env` file ALLOW-LIST (BST-1361) — the ONLY variables a desktop env file
 * may set: the registry-derived credential names plus the deliberate
 * non-credential names above. This is a PRIVILEGE BOUNDARY, not hygiene: an
 * unrestricted file would escalate a write to `<userData>/.env` into code
 * execution and traffic interception via NODE_OPTIONS, PATH,
 * DYLD_INSERT_LIBRARIES, NODE_EXTRA_CA_CERTS, or HTTPS_PROXY — and could set
 * NODE_ENV / ELECTRON_IS_E2E_TEST to flip this process's own test-mode
 * semantics. Deprecated registry names stay listed forever: an unrecognized
 * name rejects the WHOLE file, so dropping them would brick existing user
 * files. Recognized-but-deprecated parses fine and is reported by name in
 * {@link DesktopEnvLoadResult.deprecatedVariableNames}.
 *
 * Exported so `.env.example` is contract-tested against it
 * (env-example-contract.test.ts) and the example can never drift from the
 * registry either.
 */
export const SUPPORTED_ENV_FILE_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...CREDENTIAL_ENV_FILE_VARIABLE_NAMES,
  ...NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES,
]);
const DEPRECATED_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>(
  listProviders().flatMap((definition) => [...providerDeprecatedEnvKeys(definition.id)])
);
let bootstrapResult: DesktopEnvLoadResult | undefined;

/**
 * Copy a parent process environment without Brainstrike provider credentials.
 *
 * Repository-controlled child processes must not inherit credentials merely
 * because Desktop resolved them through the main-process environment. The
 * scrub uses {@link SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES} — the file set
 * PLUS ambient-only credentials such as AWS static keys (PR #2525 review,
 * finding 1). Non-credential supported names (AWS_REGION, AWS_PROFILE) are
 * configuration and pass through.
 *
 * This is a DENY-LIST: a credential name missing from that set is copied
 * verbatim. Do not "simplify" it back to the file set.
 */
export function createCredentialIsolatedChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    // Windows environment names are case-insensitive. Apply the same rule on
    // every platform so a mixed-case source object cannot bypass this boundary
    // in tests, IPC adapters, or a future cross-platform caller.
    if (!SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

export function isDesktopEnvFileLoadingDisabled(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv>
): boolean {
  return (
    argv.includes('--test-mode') ||
    env['ELECTRON_IS_E2E_TEST'] === 'true' ||
    env['NODE_ENV'] === 'test'
  );
}

/**
 * Loads desktop environment files without ever partially applying them.
 *
 * Every existing candidate is read and validated first. If any candidate is
 * unreadable or invalid, no candidate mutates the target environment.
 * Existing process variables remain authoritative, followed by `.env.local`,
 * `.env`, and the packaged user-data `.env`.
 */
export function loadDesktopEnvironment({
  appRoot,
  argv = process.argv,
  env = process.env,
  isPackaged,
  userDataPath,
}: LoadDesktopEnvironmentOptions): DesktopEnvLoadResult {
  if (isDesktopEnvFileLoadingDisabled(argv, env)) {
    return emptyResult(true);
  }

  const candidates = buildDesktopEnvCandidates(appRoot, userDataPath, isPackaged);
  const parsedCandidates: ParsedDesktopEnvCandidate[] = [];
  const failures: DesktopEnvLoadFailure[] = [];

  for (const candidate of candidates) {
    const result = readAndParseCandidate(candidate);
    if (result === null) {
      continue;
    }
    if ('code' in result) {
      failures.push(result);
      continue;
    }
    parsedCandidates.push(result);
  }

  if (failures.length > 0) {
    return {
      appliedVariableCount: 0,
      deprecatedVariableNames: [],
      failures,
      loadedFiles: [],
      skipped: false,
    };
  }

  const assignments = collectAssignments(parsedCandidates, env);
  for (const [name, value] of assignments) {
    env[name] = value;
  }

  return {
    appliedVariableCount: assignments.size,
    deprecatedVariableNames: collectDeprecatedVariableNames(parsedCandidates),
    failures: [],
    loadedFiles: parsedCandidates.map(({ file }) => file),
    skipped: false,
  };
}

export function initializeDesktopEnvironment(
  options: LoadDesktopEnvironmentOptions
): DesktopEnvLoadResult {
  if (bootstrapResult) {
    throw new Error('Desktop environment bootstrap was initialized more than once.');
  }
  bootstrapResult = loadDesktopEnvironment(options);
  return bootstrapResult;
}

export function getDesktopEnvironmentBootstrapResult(): DesktopEnvLoadResult {
  if (bootstrapResult) {
    return bootstrapResult;
  }
  if (isDesktopEnvFileLoadingDisabled(process.argv, process.env)) {
    return emptyResult(true);
  }
  throw new Error('Desktop main runtime started before environment bootstrap.');
}

function emptyResult(skipped: boolean): DesktopEnvLoadResult {
  return {
    appliedVariableCount: 0,
    deprecatedVariableNames: [],
    failures: [],
    loadedFiles: [],
    skipped,
  };
}

/** Deprecated NAMES spelled in the loaded files — deduplicated, values never included. */
function collectDeprecatedVariableNames(
  candidates: readonly ParsedDesktopEnvCandidate[]
): readonly string[] {
  const names = new Set<string>();
  for (const candidate of candidates) {
    for (const name of candidate.entries.keys()) {
      if (DEPRECATED_VARIABLE_NAMES.has(name)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * The candidate files for a launch mode, in load order. Exported as the SINGLE
 * source of env-file paths: the BST-1363 settings projection maps recorded
 * file ids back to paths through this same function, so a path shown in
 * Settings can never drift from a path the loader actually read.
 */
export function buildDesktopEnvCandidates(
  appRoot: string,
  userDataPath: string,
  isPackaged: boolean
): DesktopEnvCandidate[] {
  if (isPackaged) {
    return [{ file: 'user-data', path: path.join(userDataPath, '.env') }];
  }
  return [
    { file: 'dev-local', path: path.join(appRoot, '.env.local') },
    { file: 'dev', path: path.join(appRoot, '.env') },
  ];
}

function readAndParseCandidate(
  candidate: DesktopEnvCandidate
): DesktopEnvLoadFailure | ParsedDesktopEnvCandidate | null {
  let contents: Buffer;
  try {
    contents = fs.readFileSync(candidate.path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    return {
      code: 'env_file_unreadable',
      file: candidate.file,
      // Failure text names the FILE the user must open, not the loader's
      // internal id — this message reaches Settings, the assistant status
      // probe, and the secrets:list error verbatim.
      message: `Desktop environment file "${DESKTOP_ENV_FILE_LABELS[candidate.file]}" could not be read.`,
    };
  }

  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return {
      entries: parseDesktopEnvSource(source),
      file: candidate.file,
    };
  } catch (error) {
    const parseError =
      error instanceof DesktopEnvParseError
        ? error
        : new DesktopEnvParseError(1, 'file is not valid UTF-8.');
    return {
      code: 'env_file_invalid',
      file: candidate.file,
      message: `Desktop environment file "${DESKTOP_ENV_FILE_LABELS[candidate.file]}" is invalid at line ${parseError.line}: ${parseError.message}`,
    };
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function parseDesktopEnvSource(source: string): ReadonlyMap<string, string> {
  if (source.includes('\0')) {
    throw new DesktopEnvParseError(1, 'null bytes are not supported.');
  }

  const normalized = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const entries = new Map<string, string>();
  // CR, LF and CRLF all terminate a line. Splitting on /\r?\n/ alone leaves a
  // lone CR (classic-Mac line endings, or a mangled paste) inside the value,
  // so `A=1\rB=2` would silently become ONE assignment whose secret carries a
  // control character and a second variable's text.
  const lines = normalized.split(/\r\n|\n|\r/u);

  for (const [index, line] of lines.entries()) {
    parseDesktopEnvLine(line, index + 1, entries);
  }
  return entries;
}

function parseDesktopEnvLine(line: string, lineNumber: number, entries: Map<string, string>): void {
  const trimmedStart = line.trimStart();
  if (trimmedStart.length === 0 || trimmedStart.startsWith('#')) {
    return;
  }
  if (trimmedStart !== line) {
    throw new DesktopEnvParseError(lineNumber, 'boundary whitespace.');
  }

  const declaration = stripExportPrefix(line);
  const equalsIndex = declaration.indexOf('=');
  if (equalsIndex < 0) {
    throw new DesktopEnvParseError(lineNumber, 'expected "=".');
  }

  const name = declaration.slice(0, equalsIndex);
  if (!VARIABLE_NAME_PATTERN.test(name)) {
    throw new DesktopEnvParseError(lineNumber, 'invalid variable name.');
  }
  if (!SUPPORTED_ENV_FILE_VARIABLE_NAMES.has(name)) {
    throw new DesktopEnvParseError(lineNumber, 'unsupported variable name.');
  }

  const rawValue = declaration.slice(equalsIndex + 1);
  if (rawValue !== rawValue.trimStart()) {
    throw new DesktopEnvParseError(lineNumber, 'boundary whitespace.');
  }
  entries.set(name, parseDesktopEnvValue(rawValue, lineNumber));
}

function stripExportPrefix(line: string): string {
  if (!line.startsWith('export')) {
    return line;
  }
  const suffix = line.slice('export'.length);
  if (!/^[ \t]/u.test(suffix)) {
    return line;
  }
  return suffix.trimStart();
}

function parseDesktopEnvValue(rawValue: string, lineNumber: number): string {
  const quote = rawValue[0];
  if (!(quote === '"' || quote === "'" || quote === '`')) {
    return parseUnquotedValue(rawValue, lineNumber);
  }

  const closingQuoteIndex = findClosingQuote(rawValue, quote);
  if (closingQuoteIndex < 0) {
    throw new DesktopEnvParseError(lineNumber, 'unterminated quote.');
  }

  const suffix = rawValue.slice(closingQuoteIndex + 1);
  if (suffix.trim().length === 0 && suffix.length > 0) {
    throw new DesktopEnvParseError(lineNumber, 'boundary whitespace.');
  }
  if (suffix.length > 0 && !/^[ \t]+#/u.test(suffix)) {
    throw new DesktopEnvParseError(lineNumber, 'unexpected content after quoted value.');
  }

  const value = rawValue.slice(1, closingQuoteIndex);
  if (quote === '"') {
    return value.replaceAll('\\n', '\n').replaceAll('\\r', '\r');
  }
  return value;
}

function findClosingQuote(value: string, quote: '"' | "'" | '`'): number {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote && !escaped) {
      return index;
    }
    if (character === '\\') {
      escaped = !escaped;
      continue;
    }
    escaped = false;
  }
  return -1;
}

function parseUnquotedValue(rawValue: string, lineNumber: number): string {
  const commentMatch = /[ \t]+#/u.exec(rawValue);
  if (commentMatch?.index !== undefined) {
    return rawValue.slice(0, commentMatch.index);
  }
  if (rawValue !== rawValue.trimEnd()) {
    throw new DesktopEnvParseError(lineNumber, 'boundary whitespace.');
  }
  return rawValue;
}

function collectAssignments(
  candidates: readonly ParsedDesktopEnvCandidate[],
  env: Readonly<NodeJS.ProcessEnv>
): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>();
  for (const candidate of candidates) {
    for (const [name, value] of candidate.entries) {
      if (Object.hasOwn(env, name) || assignments.has(name)) {
        continue;
      }
      assignments.set(name, value);
    }
  }
  return assignments;
}
