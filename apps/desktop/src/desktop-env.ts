import fs from 'node:fs';
import path from 'node:path';
import { listProviders, providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import { TAVILY_ENV_KEYS } from './tavily-env-keys';

export type DesktopEnvFile = 'dev' | 'dev-local' | 'user-data';

export interface DesktopEnvLoadFailure {
  readonly code: 'env_file_invalid' | 'env_file_unreadable';
  readonly file: DesktopEnvFile;
  readonly message: string;
}

export interface DesktopEnvLoadResult {
  readonly appliedVariableCount: number;
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
 * The ONLY variables a desktop `.env` file may set.
 *
 * This is a PRIVILEGE BOUNDARY, not hygiene: the main process environment is
 * inherited wholesale by every child it spawns (execute-command-tool,
 * command-session-manager, terminal-ipc-handlers, lsp-diagnostics,
 * hooks/executor, run-skill-script-tool), so an unrestricted file would
 * escalate a write to `<userData>/.env` into code execution and traffic
 * interception via NODE_OPTIONS, PATH, DYLD_INSERT_LIBRARIES,
 * NODE_EXTRA_CA_CERTS, or HTTPS_PROXY — and could set NODE_ENV /
 * ELECTRON_IS_E2E_TEST to flip this process's own test-mode semantics.
 *
 * Derived from the shared provider registry plus the Tavily names rather than
 * hand-copied: a hand-written list silently drifts from the registry, and a
 * name the registry documents but this list omits rejects the WHOLE file.
 */
const SUPPORTED_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...listProviders().flatMap((definition) => [...providerEnvKeys(definition.id)]),
  ...TAVILY_ENV_KEYS,
]);
let bootstrapResult: DesktopEnvLoadResult | undefined;

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

  const candidates = buildCandidates(appRoot, userDataPath, isPackaged);
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
    failures: [],
    loadedFiles: [],
    skipped,
  };
}

function buildCandidates(
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
      message: `Desktop environment file "${candidate.file}" could not be read.`,
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
      message: `Desktop environment file "${candidate.file}" is invalid at line ${parseError.line}: ${parseError.message}`,
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
  const lines = normalized.split(/\r?\n/u);

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
  if (!SUPPORTED_VARIABLE_NAMES.has(name)) {
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
