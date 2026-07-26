/**
 * Lens contract (BST-921): named, parameterized retrieval SQL versioned as
 * repo files under `.brainstrike/lenses/*.sql`, executed EXCLUSIVELY through
 * the `brainstrike.querySelf` sandbox with real bind parameters.
 *
 * This module is the pure grammar — no fs, no Electron — shared by the
 * desktop loader (which scans directories, mirroring the persona loader) and
 * the packages/db golden tests (which parse the shipped lens files directly,
 * so the checked-in artifact is the single source of truth).
 *
 * Posture mirrors user-personas.ts: hand-rolled parsing (no YAML dep),
 * fail-closed on malformed input with a structured error string, never a
 * throw, never a silent fix-up. A lens file is untrusted repo content.
 */

/** Directory (under `.brainstrike/`) scanned for lens `.sql` files. */
export const USER_LENS_DIRNAME = 'lenses';

/** Total lens count cap per scan; the rest are ignored with a visible warn. */
export const MAX_USER_LENSES = 50;

/** Per-file char cap — same untrusted-content posture as personas/commands. */
export const MAX_USER_LENS_FILE_CHARS = 16 * 1024;

/** Declared-parameter cap; a lens needing more is a design smell, not a limit to raise. */
export const MAX_USER_LENS_PARAMS = 8;

/** SQL body cap (the querySelf `sql` input caps at 4000; lenses may be larger
 * because they are reviewed artifacts, but they are still bounded). */
export const MAX_USER_LENS_SQL_CHARS = 8000;

const LENS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LENS_PARAM_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export const LENS_PARAM_TYPES = ['text', 'integer', 'number', 'boolean'] as const;
export type LensParamType = (typeof LENS_PARAM_TYPES)[number];

export interface LensParamSpec {
  readonly description: string;
  readonly name: string;
  readonly type: LensParamType;
}

export interface LensDefinition {
  readonly description: string;
  readonly id: string;
  readonly params: readonly LensParamSpec[];
  readonly sql: string;
}

export type ParseLensFileResult =
  | { readonly lens: LensDefinition; readonly ok: true }
  | { readonly error: string; readonly ok: false };

function isLensParamType(value: string): value is LensParamType {
  return (LENS_PARAM_TYPES as readonly string[]).includes(value);
}

/**
 * Parses one lens file. The header is the leading run of `--` comment lines;
 * the first line that is neither a comment nor blank ends it, and EVERYTHING
 * from there on (interior comments included) is the SQL body.
 *
 * Placeholder discipline is validated at PARSE time, not left to the engine:
 * the SQL's highest `$n` must equal the declared param count and every
 * `$1..$n` must appear. An unused or excess placeholder is an authoring
 * error surfaced in the lens listing — not a runtime surprise for the model.
 * (The `$n` scan is a plain regex and deliberately does not attempt to skip
 * string literals; a literal containing `$3` overcounts, which fails CLOSED —
 * the author renames the literal.)
 */
export function parseLensFile(fileName: string, content: string): ParseLensFileResult {
  if (!fileName.toLowerCase().endsWith('.sql')) {
    return { error: `Lens file must have a .sql extension: ${fileName}`, ok: false };
  }
  const id = fileName.slice(0, -'.sql'.length);
  if (!LENS_ID_PATTERN.test(id)) {
    return {
      error: `Lens id (the filename) must match ${String(LENS_ID_PATTERN)}: ${fileName}`,
      ok: false,
    };
  }
  if (content.length > MAX_USER_LENS_FILE_CHARS) {
    return { error: `Lens file exceeds ${MAX_USER_LENS_FILE_CHARS} characters.`, ok: false };
  }

  const lines = content.split('\n');
  const header = parseLensHeader(lines);
  if ('error' in header) {
    return { error: header.error, ok: false };
  }
  if (header.description === null) {
    return { error: 'Missing required "-- description:" header line.', ok: false };
  }

  const sql = lines.slice(header.bodyStart).join('\n').trim();
  if (sql.length === 0) {
    return { error: 'Lens SQL body is empty.', ok: false };
  }
  if (sql.length > MAX_USER_LENS_SQL_CHARS) {
    return { error: `Lens SQL exceeds ${MAX_USER_LENS_SQL_CHARS} characters.`, ok: false };
  }

  const placeholderError = validatePlaceholders(sql, header.params);
  if (placeholderError !== null) {
    return { error: placeholderError, ok: false };
  }

  return { lens: { description: header.description, id, params: header.params, sql }, ok: true };
}

type LensHeader =
  | { bodyStart: number; description: string | null; params: LensParamSpec[] }
  | { error: string };

function parseLensHeader(lines: readonly string[]): LensHeader {
  let description: string | null = null;
  const params: LensParamSpec[] = [];
  let bodyStart = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (!line.startsWith('--')) {
      bodyStart = index;
      break;
    }
    bodyStart = index + 1;
    const comment = line.slice(2).trim();
    if (comment.startsWith('description:')) {
      const value = comment.slice('description:'.length).trim();
      if (description !== null) {
        return { error: 'Duplicate "-- description:" header line.' };
      }
      if (value.length === 0) {
        return { error: 'The "-- description:" header must not be empty.' };
      }
      description = value;
    } else if (comment.startsWith('param:')) {
      const paramError = ingestParamLine(comment, line, params);
      if (paramError !== null) {
        return { error: paramError };
      }
    }
    // Other comment lines in the header are allowed and ignored (license
    // headers, notes) — only the two directives are meaningful.
  }

  return { bodyStart, description, params };
}

/** Parse one `-- param:` line into `params`, returning an error or null. */
function ingestParamLine(comment: string, line: string, params: LensParamSpec[]): string | null {
  const spec = comment.slice('param:'.length).trim();
  const match = spec.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return `Malformed "-- param:" line (need "name type [description]"): ${line}`;
  }
  const [, name, type, paramDescription] = match;
  if (!(name && LENS_PARAM_NAME_PATTERN.test(name))) {
    return `Invalid param name (must match ${String(LENS_PARAM_NAME_PATTERN)}): ${name}`;
  }
  if (!(type && isLensParamType(type))) {
    return `Unknown param type "${type}" (allowed: ${LENS_PARAM_TYPES.join(', ')}).`;
  }
  if (params.some((existing) => existing.name === name)) {
    return `Duplicate param name: ${name}`;
  }
  if (params.length >= MAX_USER_LENS_PARAMS) {
    return `A lens may declare at most ${MAX_USER_LENS_PARAMS} params.`;
  }
  params.push({ description: paramDescription?.trim() ?? '', name, type });
  return null;
}

/** The parse-time placeholder discipline (see parseLensFile docs). */
function validatePlaceholders(sql: string, params: readonly LensParamSpec[]): string | null {
  const seen = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    const index = Number(match[1]);
    if (index === 0) {
      return 'Placeholder $0 is invalid; placeholders start at $1.';
    }
    seen.add(index);
  }
  for (let expected = 1; expected <= params.length; expected += 1) {
    if (!seen.has(expected)) {
      const param = params[expected - 1];
      return `Declared param "${param?.name}" ($${expected}) is never referenced in the SQL.`;
    }
  }
  for (const index of seen) {
    if (index > params.length) {
      return `SQL references $${index} but only ${params.length} param(s) are declared.`;
    }
  }
  return null;
}

export type CoerceLensValuesResult =
  | { readonly ok: true; readonly values: readonly unknown[] }
  | { readonly error: string; readonly ok: false };

/**
 * Coerces the tool call's positional string values into typed bind values.
 * Strings-in, typed-out keeps the tool input schema strict-mode-safe (no
 * unions, no records); the declared type is the contract. Fail-closed: a
 * value that does not parse names its param.
 */
export function coerceLensValues(
  params: readonly LensParamSpec[],
  values: readonly string[]
): CoerceLensValuesResult {
  if (values.length !== params.length) {
    return {
      error: `Lens expects ${params.length} value(s) (${params.map((p) => p.name).join(', ')}), got ${values.length}.`,
      ok: false,
    };
  }
  const coerced: unknown[] = [];
  for (const [index, param] of params.entries()) {
    const raw = values[index] ?? '';
    switch (param.type) {
      case 'text':
        coerced.push(raw);
        break;
      case 'integer': {
        if (!/^-?\d{1,15}$/.test(raw.trim())) {
          return { error: `Param "${param.name}" expects an integer, got: ${raw}`, ok: false };
        }
        coerced.push(Number(raw.trim()));
        break;
      }
      case 'number': {
        const value = Number(raw.trim());
        if (raw.trim().length === 0 || !Number.isFinite(value)) {
          return { error: `Param "${param.name}" expects a number, got: ${raw}`, ok: false };
        }
        coerced.push(value);
        break;
      }
      case 'boolean': {
        const normalized = raw.trim().toLowerCase();
        if (normalized !== 'true' && normalized !== 'false') {
          return { error: `Param "${param.name}" expects true or false, got: ${raw}`, ok: false };
        }
        coerced.push(normalized === 'true');
        break;
      }
      default: {
        const exhaustive: never = param.type;
        return { error: `Unhandled param type: ${String(exhaustive)}`, ok: false };
      }
    }
  }
  return { ok: true, values: coerced };
}
