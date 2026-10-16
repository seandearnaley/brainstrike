/**
 * Pure summary helpers for tool-call display: the inline header's primary-arg
 * readout and the "what came back" result count. Split out of tool-fallback.tsx
 * so that file exports only components (Fast Refresh can then preserve state)
 * — these are shared by ToolFallback and the activity working label
 * (tool-activity.ts).
 */

/**
 * Argument keys most likely to identify WHAT a tool accessed, in priority
 * order. The first string-valued match is surfaced inline in the card header
 * so users can read "which file / which query" without expanding details.
 */
const PRIMARY_ARG_KEYS = [
  'query',
  'q',
  'pattern',
  'path',
  'filePath',
  'file',
  'url',
  'name',
  'id',
  'command',
] as const;

/**
 * Visible cap for the inline header summary (BST-949). The `full` value always
 * survives for the `title` tooltip and the expanded Arguments pane — this cap
 * only bounds how much of the thread the summary is allowed to occupy.
 */
const MAX_PRIMARY_ARG_LENGTH = 64;
/** Middle-ellipsis split for path-like values: tail keeps the basename. */
const PATH_TAIL_LENGTH = 39;
/** Head + '…' + tail must land exactly on the cap: 24 + 1 + 39 = 64. */
const PATH_HEAD_LENGTH = MAX_PRIMARY_ARG_LENGTH - PATH_TAIL_LENGTH - 1;

/** Argument keys whose values are paths by construction (not by heuristic). */
const PATH_ARG_KEYS: ReadonlySet<string> = new Set(['path', 'filePath', 'file', 'url']);

export interface PrimaryArgSummary {
  /** Capped text for the inline header. */
  display: string;
  /** Normalized but UNtruncated value — the hover tooltip. Compact detail
      mode has no expander, so this is the only way to inspect long args. */
  full: string;
}

export function extractPrimaryArg(
  args: unknown,
  argsText: string | undefined
): PrimaryArgSummary | undefined {
  let record: Record<string, unknown> | undefined;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    record = args as Record<string, unknown>;
  } else if (argsText) {
    try {
      const parsed: unknown = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      return;
    }
  }
  if (!record) {
    return;
  }

  for (const key of PRIMARY_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return summarizePrimaryArg(value, PATH_ARG_KEYS.has(key));
    }
  }
  const firstString = Object.values(record).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return firstString ? summarizePrimaryArg(firstString, false) : undefined;
}

function summarizePrimaryArg(value: string, isPathKey: boolean): PrimaryArgSummary {
  const full = value.replaceAll(/\s+/g, ' ').trim();
  // Cut on CODE POINTS, not UTF-16 units — a slice landing inside a
  // surrogate pair would render U+FFFD at the truncation seam. Scans are
  // bounded by the cap so long values never expand into a code-point array.
  const capEnd = advanceCodePoints(full, MAX_PRIMARY_ARG_LENGTH);
  if (capEnd === full.length) {
    return { display: full, full };
  }
  // Paths lose their identity when the END is cut (the basename is the part
  // users recognize), so path-like values ellipsize in the MIDDLE instead.
  // A path-typed key is authoritative (Windows roots and spaced directories
  // are still paths); the separator heuristic only covers untyped keys.
  const isPathLike = isPathKey || (!full.includes(' ') && /[/\\]/.test(full));
  if (isPathLike) {
    const head = full.slice(0, advanceCodePoints(full, PATH_HEAD_LENGTH));
    const tail = full.slice(retreatCodePoints(full, PATH_TAIL_LENGTH));
    return { display: `${head}…${tail}`, full };
  }
  const displayEnd = advanceCodePoints(full, MAX_PRIMARY_ARG_LENGTH - 1);
  return { display: `${full.slice(0, displayEnd)}…`, full };
}

/** Advance by Unicode code points without materializing the complete string. */
function advanceCodePoints(value: string, count: number): number {
  let index = 0;
  for (let seen = 0; seen < count && index < value.length; seen++) {
    const codeUnit = value.charCodeAt(index);
    index++;
    if (codeUnit >= 0xd8_00 && codeUnit <= 0xdb_ff && index < value.length) {
      const nextCodeUnit = value.charCodeAt(index);
      if (nextCodeUnit >= 0xdc_00 && nextCodeUnit <= 0xdf_ff) {
        index++;
      }
    }
  }
  return index;
}

/** Retreat by Unicode code points without materializing the complete string. */
function retreatCodePoints(value: string, count: number): number {
  let index = value.length;
  for (let seen = 0; seen < count && index > 0; seen++) {
    index--;
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xdc_00 && codeUnit <= 0xdf_ff && index > 0) {
      const previousCodeUnit = value.charCodeAt(index - 1);
      if (previousCodeUnit >= 0xd8_00 && previousCodeUnit <= 0xdb_ff) {
        index--;
      }
    }
  }
  return index;
}

/**
 * Compact "what came back" summary for the header: item counts for arrays and
 * common collection-shaped results. Returns undefined when there is nothing
 * meaningful to count (the expanded Result pane remains the full view).
 */
const COLLECTION_RESULT_KEYS = ['matches', 'results', 'items', 'files', 'chunks', 'rows'] as const;

export function summarizeResult(result: unknown): string | undefined {
  if (Array.isArray(result)) {
    return `${result.length} ${result.length === 1 ? 'item' : 'items'}`;
  }
  if (!(result && typeof result === 'object')) {
    return;
  }
  const record = result as Record<string, unknown>;
  for (const key of COLLECTION_RESULT_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return `${value.length} ${key}`;
    }
  }
  return;
}
