/**
 * Hook-reported run verdicts (Task Ledger source 'hook') — strict stdout scan.
 *
 * A Stop hook may report a verdict for the finished run by printing ONE JSON
 * line to stdout: `{"brainstrikeRunVerdict":{"verdict":"failed","detail":"…"}}`.
 * Hook stdout is UNTRUSTED repo-controlled data, so parsing is STRICT and
 * fail-visible: a candidate line (any line containing the marker key) that is
 * malformed JSON, carries an unknown verdict, an oversized/non-string detail,
 * or any extra key is IGNORED with a content-free warning (surfaced as a
 * `hook.notice` run event by the manager) — never coerced, and a bad line never
 * fails the hook flow or the run. Warnings deliberately never quote the line:
 * hook stdout must not leak into logs/run events beyond bounded, redacted
 * excerpts, and a reason string needs no excerpt at all.
 *
 * Bound: only the trailing {@link RUN_VERDICT_STDOUT_SCAN_CHARS} characters of
 * stdout are scanned (a runaway test log cannot make the scan unbounded). When
 * the window slices mid-line, the partial first line is dropped rather than
 * parsed as a corrupted candidate. Within the window, the LAST valid verdict
 * line wins.
 */

export const RUN_VERDICT_KEY = 'brainstrikeRunVerdict';

/** Documented scan bound: the trailing 64 KiB (UTF-16 code units) of stdout. */
export const RUN_VERDICT_STDOUT_SCAN_CHARS = 64 * 1024;

/** Mirrors the repository's RUN_OUTCOME_DETAIL_MAX_CHARS (oversized THROWS there). */
export const RUN_VERDICT_DETAIL_MAX_CHARS = 2000;

const RUN_VERDICT_VALUES = ['succeeded', 'failed', 'mixed'] as const;

export type HookRunVerdictValue = (typeof RUN_VERDICT_VALUES)[number];

export interface HookRunVerdict {
  readonly detail?: string;
  readonly verdict: HookRunVerdictValue;
}

export interface RunVerdictScanResult {
  /** The last valid verdict line inside the scan window, if any. */
  readonly verdict?: HookRunVerdict;
  /** One content-free warning per invalid candidate line (visible, never a throw). */
  readonly warnings: readonly string[];
}

function isRunVerdictValue(value: unknown): value is HookRunVerdictValue {
  return (RUN_VERDICT_VALUES as readonly unknown[]).includes(value);
}

type LineParseResult =
  | { readonly kind: 'verdict'; readonly verdict: HookRunVerdict }
  | { readonly kind: 'invalid'; readonly reason: string };

function invalid(reason: string): LineParseResult {
  return { kind: 'invalid', reason };
}

/** Strictly parse one candidate line. Content-free reasons only (see module doc). */
function parseCandidateLine(line: string): LineParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return invalid('invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('not a JSON object');
  }
  const topKeys = Object.keys(parsed);
  if (topKeys.length !== 1 || topKeys[0] !== RUN_VERDICT_KEY) {
    return invalid(`the JSON object must have exactly one key ("${RUN_VERDICT_KEY}")`);
  }
  const payload: unknown = (parsed as Record<string, unknown>)[RUN_VERDICT_KEY];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return invalid(`"${RUN_VERDICT_KEY}" must be an object`);
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'verdict' && key !== 'detail') {
      return invalid(`unknown key in the verdict object (allowed: "verdict", "detail")`);
    }
  }
  if (!isRunVerdictValue(record['verdict'])) {
    return invalid(`unknown verdict value (allowed: ${RUN_VERDICT_VALUES.join(', ')})`);
  }
  const detail = record['detail'];
  if (detail !== undefined) {
    if (typeof detail !== 'string') {
      return invalid('detail must be a string');
    }
    if (detail.length > RUN_VERDICT_DETAIL_MAX_CHARS) {
      return invalid(`detail exceeds ${RUN_VERDICT_DETAIL_MAX_CHARS} characters`);
    }
  }
  return {
    kind: 'verdict',
    verdict: {
      verdict: record['verdict'],
      ...(typeof detail === 'string' ? { detail } : {}),
    },
  };
}

/** The trailing scan window, with any sliced-open partial first line dropped. */
function scanWindow(stdout: string): string {
  if (stdout.length <= RUN_VERDICT_STDOUT_SCAN_CHARS) {
    return stdout;
  }
  const sliced = stdout.slice(stdout.length - RUN_VERDICT_STDOUT_SCAN_CHARS);
  const firstNewline = sliced.indexOf('\n');
  // No newline in the whole window ⇒ the window is one partial line: drop it.
  return firstNewline === -1 ? '' : sliced.slice(firstNewline + 1);
}

/**
 * Scan a hook's raw stdout for a run-verdict line. Never throws; invalid
 * candidate lines surface as warnings and are ignored.
 */
export function scanStdoutForRunVerdict(stdout: string): RunVerdictScanResult {
  const window = scanWindow(stdout);
  if (!window.includes(RUN_VERDICT_KEY)) {
    return { warnings: [] };
  }
  let verdict: HookRunVerdict | undefined;
  const warnings: string[] = [];
  for (const rawLine of window.split('\n')) {
    const line = rawLine.trim();
    if (!line.includes(RUN_VERDICT_KEY)) {
      continue;
    }
    const result = parseCandidateLine(line);
    if (result.kind === 'verdict') {
      verdict = result.verdict;
      continue;
    }
    warnings.push(`Ignored a malformed ${RUN_VERDICT_KEY} stdout line: ${result.reason}.`);
  }
  return { ...(verdict ? { verdict } : {}), warnings };
}
