/**
 * Model-facing shapes for `lspInspect` — the layer between the raw LSP wire and
 * the tool result the agent reads.
 *
 * Split out of `lsp-diagnostics.ts` (BST-1614) when the honest-failure
 * vocabulary pushed that file past Biome's `noExcessiveLinesPerFile` ceiling.
 * The seam is real, not cosmetic: nothing here touches the child process, the
 * connection, or the pool — it is pure mapping from wire values to what the
 * model is told.
 *
 * The per-query budgets live here because BOTH sides must agree on them: the
 * connection races each request against them, and the failure message quotes
 * the same number back to the model.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithinRoot } from '@brainstrike/host-capabilities/native-tools';

/** Overall budget for diagnostics to arrive after opening/updating a file. */
export const DIAGNOSTIC_TIMEOUT_MS = 6000;
/** Per-request budget for a hover/definition/implementation query (Phase B). */
export const QUERY_TIMEOUT_MS = 4000;

/** The independently-bounded legs of one `lspInspect` call. Named for the
 * RESULT FIELD each one fills, so a failure record points straight at the
 * group the model must not read as empty. */
export type LspInspectQuery = 'definition' | 'diagnostics' | 'hover' | 'implementation';

/**
 * One inspection leg that did NOT answer (BST-1614).
 *
 * The whole point of this record is that an ABSENT group must never be read as
 * a verified-empty one. `queryHover`/`queryLocations` bound each request on
 * `QUERY_TIMEOUT_MS` and also survive a transport throw; without a failure
 * record both degrade to the exact value a real "no definition here" answer
 * produces, and the model reports the user's live symbol as dead code. Same
 * rationale as `grep-zero-match-probes`' `timedOut` flag next to `matchCount:0`.
 */
export interface LspQueryFailure {
  /** Model-facing sentence: which group is UNKNOWN and what not to conclude. */
  message: string;
  query: LspInspectQuery;
  reason: 'timeout' | 'error';
}

/**
 * Ceiling on the transport-error text embedded in a failure message.
 *
 * `queryFailures` is a RETURNED value, not only a projected one: the model
 * projection clips and single-lines whatever it renders, but any other
 * consumer of `LspInspectionResult` gets these strings raw. A rejected
 * JSON-RPC request can carry a large `data` payload, so neither
 * `error.message` nor `String(error)` is bounded in practice — every sibling
 * string in this file has an explicit ceiling and this one needs the same.
 */
const MAX_QUERY_FAILURE_DETAIL_CHARS = 200;

/**
 * Bound a transport-error detail and collapse it to ONE line, so it can be
 * embedded in a single-line failure record without breaking its shape.
 */
export function boundQueryFailureDetail(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_QUERY_FAILURE_DETAIL_CHARS) {
    return collapsed;
  }
  return `${codePoints.slice(0, MAX_QUERY_FAILURE_DETAIL_CHARS).join('')}…[${
    codePoints.length - MAX_QUERY_FAILURE_DETAIL_CHARS
  } detail chars omitted]`;
}

/** One unanswered leg as the connection reports it (message built here). */
export interface RawQueryFailure {
  detail?: string;
  query: LspInspectQuery;
  reason: 'timeout' | 'error';
}

/** Raw LSP Location or LocationLink (definition/implementation result). */
export interface RawLocation {
  range?: { start?: { line?: number; character?: number } };
  targetRange?: { start?: { line?: number; character?: number } };
  targetSelectionRange?: { start?: { line?: number; character?: number } };
  targetUri?: string;
  uri?: string;
}

/** One definition/implementation location in model-facing shape. */
export interface InspectLocation {
  /** 1-based line of the target. */
  line: number;
  /** Workspace-relative path when under the root, else absolute. */
  path: string;
  /** Bounded one-line preview of the target line, when readable. */
  preview?: string;
}

/** file:// URI → fs path. fileURLToPath (not URL.pathname) so Windows drive
 * letters round-trip ("file:///C:/x" → "C:\x", not "/C:/x"). A malformed
 * file URI from the server falls through to the raw URI, which stays visible
 * in the location's display path rather than failing the whole inspection. */
function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

const MAX_INSPECT_LOCATIONS = 10;
const MAX_HOVER_CHARS = 1200;
const MAX_PREVIEW_CHARS = 200;
/**
 * Ceiling on a definition/implementation TARGET file we'll read just to build a
 * one-line preview. tsserver routinely resolves into large generated `.d.ts`
 * files; reading a multi-MB target whole into Electron main for a 200-char
 * preview would memory-spike and bypasses the workspace reader's own size
 * guard. Over this, the preview is omitted (path + line are still returned).
 */
const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;

/** Workspace-relative "/path" when under root, else the absolute path. */
function toDisplayPath(absolutePath: string, rootPath: string): string {
  const relative = path.relative(rootPath, absolutePath);
  if (relative && isWithinRoot(rootPath, absolutePath)) {
    return `/${relative.split(path.sep).join('/')}`;
  }
  return absolutePath;
}

/**
 * Best-effort bounded preview of a 1-based line (undefined on read error or an
 * oversized target). Stats first so a huge generated `.d.ts` target can't be
 * slurped whole into memory for a 200-char preview — the preview is optional,
 * so skipping it degrades an accessory field, never the location itself.
 */
async function readLinePreview(absolutePath: string, line: number): Promise<string | undefined> {
  try {
    const stat = await fsPromises.stat(absolutePath);
    if (!stat.isFile() || stat.size > MAX_PREVIEW_FILE_BYTES) {
      return;
    }
    const fileText = await fsPromises.readFile(absolutePath, 'utf8');
    const target = fileText.split('\n')[line - 1]?.trim();
    if (!target) {
      return;
    }
    return target.length > MAX_PREVIEW_CHARS ? `${target.slice(0, MAX_PREVIEW_CHARS)}…` : target;
  } catch {
    return;
  }
}

export async function toInspectLocations(
  raw: RawLocation[],
  rootPath: string
): Promise<InspectLocation[]> {
  const seen = new Set<string>();
  const locations: InspectLocation[] = [];
  for (const entry of raw.slice(0, MAX_INSPECT_LOCATIONS * 2)) {
    const uri = entry.uri ?? entry.targetUri;
    if (!uri) {
      continue;
    }
    const range = entry.range ?? entry.targetRange ?? entry.targetSelectionRange;
    const absolutePath = uriToPath(uri);
    const line = (range?.start?.line ?? 0) + 1;
    const dedupeKey = `${absolutePath}:${line}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    const preview = await readLinePreview(absolutePath, line);
    locations.push({
      line,
      path: toDisplayPath(absolutePath, rootPath),
      ...(preview ? { preview } : {}),
    });
    if (locations.length >= MAX_INSPECT_LOCATIONS) {
      break;
    }
  }
  return locations;
}

/** Clip an over-long hover blob to the model-facing bound. */
export function clipHover(hover: string | undefined): string | undefined {
  if (!hover) {
    return hover;
  }
  return hover.length > MAX_HOVER_CHARS ? `${hover.slice(0, MAX_HOVER_CHARS)}…` : hover;
}

/** What each unanswered leg leaves unknown, phrased for the model. */
const QUERY_UNKNOWN_CONSEQUENCE: Record<LspInspectQuery, string> = {
  definition:
    'definition locations are UNKNOWN for this symbol — do not conclude it has no definition or is dead code',
  diagnostics: "the inspected line's diagnostics are UNKNOWN — do not conclude the line is clean",
  hover: 'the inferred type and docs are UNKNOWN — do not conclude the symbol is untyped',
  implementation:
    'implementations are UNKNOWN for this symbol — do not conclude the interface or type has none',
};

export function toQueryFailure(raw: RawQueryFailure): LspQueryFailure {
  const cause =
    raw.reason === 'timeout'
      ? `The ${raw.query} query timed out after ${raw.query === 'diagnostics' ? DIAGNOSTIC_TIMEOUT_MS : QUERY_TIMEOUT_MS}ms`
      : `The ${raw.query} query failed (${raw.detail ?? 'unknown error'})`;
  return {
    message: `${cause}; ${QUERY_UNKNOWN_CONSEQUENCE[raw.query]}.`,
    query: raw.query,
    reason: raw.reason,
  };
}
