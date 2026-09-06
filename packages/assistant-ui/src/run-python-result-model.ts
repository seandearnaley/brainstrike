/**
 * BST-1070: the non-component half of the `run_python` result surface —
 * display-result narrowing and the shared formatters. Split from
 * `run-python-result.tsx` so the component file exports only components
 * (react-refresh `only-export-components`: Fast Refresh cannot preserve state
 * through files with mixed exports), and so the approval card and the result
 * surface share ONE duration formatter instead of two drifting copies of the
 * same rounding rule.
 */

/**
 * Display-side mirror of the agent package's `RunPythonResult` union
 * (`packages/agent/src/tools/run-python-tool.ts`). The UI package does not
 * depend on `@brainstrike/agent`, so the shape is narrowed structurally —
 * the same trade the approval-card narrowers make. Unknown EXTRA fields are
 * tolerated (results are display data, additive evolution must not blank the
 * card), but a missing required field fails the arm: a surface that guessed
 * at absent streams would be inventing output.
 */
export type RunPythonDisplayResult =
  | {
      readonly exitCode: number;
      readonly kind: 'completed';
      readonly stderr: string;
      readonly stderrOmittedBytes: number;
      readonly stdout: string;
      readonly stdoutOmittedBytes: number;
    }
  | {
      readonly kind: 'timed_out';
      readonly signal: string | null;
      readonly stderr: string;
      readonly stderrOmittedBytes: number;
      readonly stdout: string;
      readonly stdoutOmittedBytes: number;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: 'killed';
      readonly signal: string | null;
      readonly stderr: string;
      readonly stderrOmittedBytes: number;
      readonly stdout: string;
      readonly stdoutOmittedBytes: number;
    }
  | {
      readonly kind: 'cancelled';
      readonly partialStderr: string;
      readonly partialStdout: string;
      readonly stderrOmittedBytes: number;
      readonly stdoutOmittedBytes: number;
    }
  | { readonly deniedDomains: readonly string[]; readonly kind: 'network_denied' }
  | {
      /**
       * The user declined Gate A, so nothing ran (BST-1097: the decline
       * resumes the tool's own approval suspension, so the TOOL reports it
       * as a typed arm instead of Mastra's generic not-approved object).
       */
      readonly kind: 'declined';
    }
  | { readonly detail: string; readonly kind: 'unavailable'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

interface OmittedByteFields {
  readonly stderrOmittedBytes: number;
  readonly stdoutOmittedBytes: number;
}

interface StreamFields extends OmittedByteFields {
  readonly stderr: string;
  readonly stdout: string;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function hasOmittedByteFields(
  value: Record<string, unknown>
): value is Record<string, unknown> & OmittedByteFields {
  return (
    isNonNegativeSafeInteger(value['stdoutOmittedBytes']) &&
    isNonNegativeSafeInteger(value['stderrOmittedBytes'])
  );
}

function hasStreamFields(
  value: Record<string, unknown>
): value is Record<string, unknown> & StreamFields {
  return (
    typeof value['stdout'] === 'string' &&
    typeof value['stderr'] === 'string' &&
    hasOmittedByteFields(value)
  );
}

function isSignalField(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function readStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

export function narrowRunPythonDisplayResult(value: unknown): RunPythonDisplayResult | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value['kind']) {
    case 'completed':
      return isNonNegativeSafeInteger(value['exitCode']) && hasStreamFields(value)
        ? {
            ...value,
            exitCode: value['exitCode'],
            kind: 'completed',
            stderr: value.stderr,
            stderrOmittedBytes: value.stderrOmittedBytes,
            stdout: value.stdout,
            stdoutOmittedBytes: value.stdoutOmittedBytes,
          }
        : null;
    case 'timed_out':
      return isPositiveSafeInteger(value['timeoutMs']) &&
        isSignalField(value['signal']) &&
        hasStreamFields(value)
        ? {
            ...value,
            kind: 'timed_out',
            signal: value['signal'],
            stderr: value.stderr,
            stderrOmittedBytes: value.stderrOmittedBytes,
            stdout: value.stdout,
            stdoutOmittedBytes: value.stdoutOmittedBytes,
            timeoutMs: value['timeoutMs'],
          }
        : null;
    case 'killed':
      return isSignalField(value['signal']) && hasStreamFields(value)
        ? {
            ...value,
            kind: 'killed',
            signal: value['signal'],
            stderr: value.stderr,
            stderrOmittedBytes: value.stderrOmittedBytes,
            stdout: value.stdout,
            stdoutOmittedBytes: value.stdoutOmittedBytes,
          }
        : null;
    case 'cancelled':
      // The omitted-byte fields are validated here too (every stream-carrying
      // arm is): forwarding an undefined count into the pane would defeat its
      // "nothing to show" early-return and render bare labels over nothing.
      return typeof value['partialStdout'] === 'string' &&
        typeof value['partialStderr'] === 'string' &&
        hasOmittedByteFields(value)
        ? {
            ...value,
            kind: 'cancelled',
            partialStderr: value['partialStderr'],
            partialStdout: value['partialStdout'],
            stderrOmittedBytes: value.stderrOmittedBytes,
            stdoutOmittedBytes: value.stdoutOmittedBytes,
          }
        : null;
    case 'network_denied': {
      const deniedDomains = readStringArray(value['deniedDomains']);
      return deniedDomains ? { ...value, deniedDomains, kind: 'network_denied' } : null;
    }
    case 'declined':
      return { ...value, kind: 'declined' };
    case 'unavailable':
      return typeof value['reason'] === 'string' && typeof value['detail'] === 'string'
        ? { ...value, detail: value['detail'], kind: 'unavailable', reason: value['reason'] }
        : null;
    default:
      return null;
  }
}

/**
 * `812 bytes` / `41.0 KB` / `4.4 MB` at one decimal for KB/MB. DECIMAL units
 * (1000-based), matching what macOS Finder and every consumer OS shows users —
 * a byte count on a user-facing card should agree with the number they would
 * see in their file manager.
 */
export function formatOmittedBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1000) {
    return `${(bytes / 1000).toFixed(1)} KB`;
  }
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

/**
 * "30 seconds" / "1 minute" / "0.4 seconds" — never raw milliseconds, and
 * never ROUNDED to a false statement: the schema accepts any positive integer
 * of milliseconds, and a security card saying "0 seconds" (or "1 second" for
 * 400 ms) would misstate the terms being approved. Sub-second and fractional
 * values render exactly, with trailing zeros trimmed. Shared by the approval
 * card and the result surface so the two agree about what "30 seconds" means.
 */
export function formatRunDuration(timeoutMs: number): string {
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = timeoutMs / 1000;
  // Up to 3 decimals (millisecond precision is the schema's own resolution),
  // trailing zeros trimmed by Number() round-trip.
  const rendered = Number(seconds.toFixed(3));
  return `${rendered} ${rendered === 1 ? 'second' : 'seconds'}`;
}
