import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';
import { isDesktopTestMode } from './desktop-test-mode';

const logger = createLogger('DesktopEnvFiles');

/** `KEY` must be a POSIX-style shell identifier. No `export`, no spaces. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type DesktopEnvFileFailureReason = 'malformed_file' | 'unreadable_file';

export interface DesktopEnvFileFailure {
  /** Absolute path of the rejected file. */
  readonly filePath: string;
  /** 1-based line that failed to parse, or null for a read failure. */
  readonly line: number | null;
  /** Safe, value-free description of what is wrong. */
  readonly message: string;
  readonly reason: DesktopEnvFileFailureReason;
}

export interface DesktopEnvFileLoadReport {
  /** Names ONLY of variables this loader set. Values never leave the process env. */
  readonly appliedKeys: readonly string[];
  readonly failures: readonly DesktopEnvFileFailure[];
  readonly loadedFiles: readonly string[];
  readonly skipped: 'test_mode' | null;
}

export interface ResolveDesktopEnvFilePathsOptions {
  /** `app.getAppPath()` — the repo's `apps/desktop` directory during dev. */
  readonly appDirectory: string | null;
  readonly isPackaged: boolean;
  /** `app.getPath('userData')`. */
  readonly userDataDirectory: string | null;
}

export interface ApplyDesktopEnvFilesOptions extends ResolveDesktopEnvFilePathsOptions {
  /** Target environment. Defaults to `process.env`; injected in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

class EnvFileParseError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(message);
    this.line = line;
    this.name = 'EnvFileParseError';
  }
}

const EMPTY_REPORT: DesktopEnvFileLoadReport = {
  appliedKeys: [],
  failures: [],
  loadedFiles: [],
  skipped: null,
};

let lastReport: DesktopEnvFileLoadReport = EMPTY_REPORT;

/**
 * The most recent `applyDesktopEnvFiles` result. Startup runs the loader once,
 * so this is how later consumers (secrets IPC → Settings) surface a rejected
 * file instead of leaving a silently-unapplied credential file on disk.
 */
export function getDesktopEnvFileLoadReport(): DesktopEnvFileLoadReport {
  return lastReport;
}

function unescapeDoubleQuoted(inner: string, line: number): string {
  let result = '';
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character === '"') {
      throw new EnvFileParseError(line, `Line ${line} contains an unescaped double quote.`);
    }
    if (character !== '\\') {
      result += character;
      continue;
    }
    index += 1;
    const escaped = inner[index];
    switch (escaped) {
      case 'n':
        result += '\n';
        break;
      case 'r':
        result += '\r';
        break;
      case 't':
        result += '\t';
        break;
      case '\\':
        result += '\\';
        break;
      case '"':
        result += '"';
        break;
      default:
        throw new EnvFileParseError(line, `Line ${line} contains an unsupported escape sequence.`);
    }
  }
  return result;
}

function parseEnvValue(raw: string, line: number): string {
  if (raw.length === 0) {
    return '';
  }

  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    if (raw.length < 2 || raw.at(-1) !== quote) {
      throw new EnvFileParseError(line, `Line ${line} has an unterminated quoted value.`);
    }
    const inner = raw.slice(1, -1);
    if (quote === "'") {
      if (inner.includes("'")) {
        throw new EnvFileParseError(line, `Line ${line} contains an unescaped single quote.`);
      }
      return inner;
    }
    return unescapeDoubleQuoted(inner, line);
  }

  if (/[#'"\\]/.test(raw)) {
    throw new EnvFileParseError(
      line,
      `Line ${line} has an unquoted value containing a quote, backslash, or '#'. Quote the value; inline comments are not supported.`
    );
  }
  if (/^\s|\s$/.test(raw)) {
    throw new EnvFileParseError(
      line,
      `Line ${line} pads its value with whitespace. Write KEY=VALUE with no spaces around '=', or quote the value.`
    );
  }
  return raw;
}

/**
 * Strict `.env` parser. Deliberately hand-rolled rather than `dotenv`, which is
 * lenient by design (it silently drops or coerces anything it cannot read).
 * A credential file that does not say exactly what it means must FAIL.
 *
 * Grammar: blank lines, `# comment` lines, and `KEY=VALUE` assignments where
 * VALUE is bare (no quote/backslash/`#`/padding), `'single quoted'` (literal),
 * or `"double quoted"` (with `\n`, `\r`, `\t`, `\\`, `\"` escapes).
 *
 * @throws EnvFileParseError on the first offending line — the caller rejects
 *   the WHOLE file, so a partially-understood file is never partly applied.
 */
export function parseEnvFileContent(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      throw new EnvFileParseError(line, `Line ${line} is not a KEY=VALUE assignment.`);
    }

    const key = trimmed.slice(0, separatorIndex);
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new EnvFileParseError(
        line,
        `Line ${line} has an invalid variable name; expected KEY=VALUE with no spaces or 'export'.`
      );
    }
    if (entries.has(key)) {
      throw new EnvFileParseError(line, `Line ${line} redefines ${key}.`);
    }

    entries.set(key, parseEnvValue(trimmed.slice(separatorIndex + 1), line));
  }

  return entries;
}

/**
 * Candidate env files, HIGHEST precedence first. Dev launches read the repo's
 * `apps/desktop/.env.local` then `.env`; every launch reads `<userData>/.env`.
 * Packaged builds have no repo checkout, so only the user-data file applies.
 */
export function resolveDesktopEnvFilePaths({
  appDirectory,
  isPackaged,
  userDataDirectory,
}: ResolveDesktopEnvFilePathsOptions): string[] {
  const paths: string[] = [];
  if (!isPackaged && appDirectory) {
    paths.push(path.join(appDirectory, '.env.local'), path.join(appDirectory, '.env'));
  }
  if (userDataDirectory) {
    paths.push(path.join(userDataDirectory, '.env'));
  }
  return paths;
}

function readEnvFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

interface EnvFileOutcome {
  /** Parsed entries when the file exists AND parsed cleanly. */
  readonly entries?: Map<string, string>;
  /** The visible rejection when the file exists but could not be used. */
  readonly failure?: DesktopEnvFileFailure;
}

/**
 * Reads and strictly parses one candidate file. A missing file is normal (empty
 * outcome); a read or parse failure rejects that file WHOLE and is logged
 * without its contents.
 */
function readParsedEnvFile(filePath: string): EnvFileOutcome {
  let content: string | null;
  try {
    content = readEnvFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to read desktop environment file', { filePath, message });
    return { failure: { filePath, line: null, message, reason: 'unreadable_file' } };
  }
  if (content === null) {
    return {};
  }

  try {
    return { entries: parseEnvFileContent(content) };
  } catch (error) {
    const line = error instanceof EnvFileParseError ? error.line : null;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      'Rejected malformed desktop environment file; NONE of its variables were applied',
      { filePath, line, message }
    );
    return { failure: { filePath, line, message, reason: 'malformed_file' } };
  }
}

/** Applies entries that are not already set, returning the applied NAMES. */
function applyEntries(entries: Map<string, string>, env: NodeJS.ProcessEnv): string[] {
  const applied: string[] = [];
  for (const [key, value] of entries) {
    if (key in env) {
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Loads the desktop provider env files into `env` (default `process.env`).
 *
 * Precedence: an already-set variable ALWAYS wins, then `.env.local`, `.env`,
 * `<userData>/.env`. Nothing is ever overwritten. A malformed or unreadable
 * file is rejected whole, logged as a startup error, and recorded in the
 * returned report so Settings can show it. Inert in test mode.
 */
export function applyDesktopEnvFiles(
  options: ApplyDesktopEnvFilesOptions
): DesktopEnvFileLoadReport {
  if (isDesktopTestMode()) {
    lastReport = { ...EMPTY_REPORT, skipped: 'test_mode' };
    logger.debug('Skipped desktop environment files in test mode');
    return lastReport;
  }

  const env = options.env ?? process.env;
  const appliedKeys: string[] = [];
  const failures: DesktopEnvFileFailure[] = [];
  const loadedFiles: string[] = [];

  for (const filePath of resolveDesktopEnvFilePaths(options)) {
    const outcome = readParsedEnvFile(filePath);
    if (outcome.failure) {
      failures.push(outcome.failure);
      continue;
    }
    if (!outcome.entries) {
      continue;
    }

    loadedFiles.push(filePath);
    appliedKeys.push(...applyEntries(outcome.entries, env));
  }

  lastReport = { appliedKeys, failures, loadedFiles, skipped: null };
  if (appliedKeys.length > 0) {
    logger.info('Applied desktop environment files', {
      appliedKeys,
      loadedFiles,
    });
  }
  return lastReport;
}
