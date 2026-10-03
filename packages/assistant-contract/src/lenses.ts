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
export const QUERY_SELF_TARGETS = ['app', 'index'] as const;
export type QuerySelfTarget = (typeof QUERY_SELF_TARGETS)[number];

export interface LensParamSpec {
  readonly description: string;
  readonly name: string;
  readonly type: LensParamType;
}

export interface LensRequirement {
  readonly kind: 'caller-vectors';
  readonly seedParam: string;
}

export interface LensDefinition {
  readonly description: string;
  readonly id: string;
  readonly params: readonly LensParamSpec[];
  readonly requirement?: LensRequirement;
  readonly sql: string;
  readonly target: QuerySelfTarget;
}

export type ParseLensFileResult =
  | { readonly lens: LensDefinition; readonly ok: true }
  | { readonly error: string; readonly ok: false };

function isLensParamType(value: string): value is LensParamType {
  return (LENS_PARAM_TYPES as readonly string[]).includes(value);
}

export type DeriveLensIdResult =
  | { readonly id: string; readonly ok: true }
  | { readonly error: string; readonly ok: false };

/**
 * A lens id IS its filename stem — the SINGLE derivation, shared by the
 * parser and by the desktop loader's pre-parse id reservation.
 *
 * Exported because the loader must reserve an id BEFORE reading the file (a
 * broken project lens has to block a same-named global one), and a second
 * hand-rolled `replace(/\.sql$/i, '')` there had already drifted: it accepted
 * `MyLens.SQL` as the id `MyLens`, which this validator rejects, so the
 * reserved key and the real id disagreed. Mirrors `deriveUserPersonaId`
 * (BST-936).
 */
export function deriveLensId(fileName: string): DeriveLensIdResult {
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
  return { id, ok: true };
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
  const derived = deriveLensId(fileName);
  if (!derived.ok) {
    return { error: derived.error, ok: false };
  }
  const id = derived.id;
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
  if (header.target === null) {
    return { error: 'Missing required "-- target:" header line (app or index).', ok: false };
  }

  if (header.requirement) {
    const seed = header.params.find((param) => param.name === header.requirement?.seedParam);
    if (header.target !== 'index' || seed?.type !== 'text') {
      return {
        error: 'caller-vectors requires target index and a declared text seed param.',
        ok: false,
      };
    }
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

  return {
    lens: {
      description: header.description,
      id,
      params: header.params,
      ...(header.requirement ? { requirement: header.requirement } : {}),
      sql,
      target: header.target,
    },
    ok: true,
  };
}

interface ParsedLensHeader {
  bodyStart: number;
  description: string | null;
  params: LensParamSpec[];
  requirement?: LensRequirement;
  target: QuerySelfTarget | null;
}
type LensHeader = ParsedLensHeader | { error: string };

function parseLensHeader(lines: readonly string[]): LensHeader {
  const header: ParsedLensHeader = { bodyStart: 0, description: null, params: [], target: null };
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (!line.startsWith('--')) {
      header.bodyStart = index;
      break;
    }
    header.bodyStart = index + 1;
    const error = ingestHeaderComment(line.slice(2).trim(), line, header);
    if (error !== null) {
      return { error };
    }
  }
  return header;
}

function ingestHeaderComment(
  comment: string,
  line: string,
  header: ParsedLensHeader
): string | null {
  if (comment.startsWith('description:')) {
    const parsed = parseLensDescription(comment, header.description);
    if ('error' in parsed) {
      return parsed.error;
    }
    header.description = parsed.description;
    return null;
  }
  if (comment.startsWith('target:')) {
    const parsed = parseLensTarget(comment, header.target);
    if ('error' in parsed) {
      return parsed.error;
    }
    header.target = parsed.target;
    return null;
  }
  if (comment.startsWith('requires:')) {
    const parsed = parseLensRequirement(comment, header.requirement);
    if ('error' in parsed) {
      return parsed.error;
    }
    header.requirement = parsed.requirement;
    return null;
  }
  if (comment.startsWith('param:')) {
    return ingestParamLine(comment, line, header.params);
  }
  // Other header comments (notes/license) are not directives.
  return null;
}

function parseLensRequirement(
  comment: string,
  existing: LensRequirement | undefined
): { requirement: LensRequirement } | { error: string } {
  if (existing) {
    return { error: 'Duplicate "-- requires:" header line.' };
  }
  const match = comment
    .slice('requires:'.length)
    .trim()
    .match(/^caller-vectors ([a-z][a-z0-9_]{0,31})$/u);
  if (!match?.[1]) {
    return {
      error:
        'Unknown or malformed lens requirement; use "-- requires: caller-vectors <text seed param>".',
    };
  }
  return { requirement: { kind: 'caller-vectors', seedParam: match[1] } };
}

function parseLensDescription(
  comment: string,
  existing: string | null
): { description: string } | { error: string } {
  if (existing !== null) {
    return { error: 'Duplicate "-- description:" header line.' };
  }
  const description = comment.slice('description:'.length).trim();
  if (description.length === 0) {
    return { error: 'The "-- description:" header must not be empty.' };
  }
  return { description };
}

function parseLensTarget(
  comment: string,
  existing: QuerySelfTarget | null
): { target: QuerySelfTarget } | { error: string } {
  if (existing !== null) {
    return { error: 'Duplicate "-- target:" header line.' };
  }
  const value = comment.slice('target:'.length).trim();
  const target = QUERY_SELF_TARGETS.find((allowed) => allowed === value);
  if (target === undefined) {
    return { error: `Unknown lens target "${value}" (allowed: ${QUERY_SELF_TARGETS.join(', ')}).` };
  }
  return { target };
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

/**
 * The parse-time placeholder discipline (see parseLensFile docs).
 *
 * `--` line comments are stripped before the scan: the parser deliberately
 * keeps interior comments in the SQL body, and a commented-out fragment
 * (`-- was: AND depth < $2`) must not count as a live placeholder — that
 * would reject a valid lens with an error pointing at SQL the engine never
 * sees. String literals remain unskipped (documented fail-closed heuristic).
 */
function validatePlaceholders(sql: string, params: readonly LensParamSpec[]): string | null {
  const scannable = sql.replace(/--[^\n]*/g, '');
  const seen = new Set<number>();
  for (const match of scannable.matchAll(/\$(\d+)/g)) {
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
