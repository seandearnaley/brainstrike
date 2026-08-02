/**
 * BST-1070: the non-component half of the `run_python` result surface —
 * display-result narrowing and the shared formatters. Split from
 * `run-python-result.tsx` so the component file exports only components
 * (react-doctor `only-export-components`: Fast Refresh cannot preserve state
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
  | { readonly detail: string; readonly kind: 'unavailable'; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOmittedByteFields(value: Record<string, unknown>): boolean {
  return (
    typeof value['stdoutOmittedBytes'] === 'number' &&
    typeof value['stderrOmittedBytes'] === 'number'
  );
}

function hasStreamFields(value: Record<string, unknown>): boolean {
  return (
    typeof value['stdout'] === 'string' &&
    typeof value['stderr'] === 'string' &&
    hasOmittedByteFields(value)
  );
}

function isSignalField(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function narrowRunPythonDisplayResult(value: unknown): RunPythonDisplayResult | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (value['kind']) {
    case 'completed':
      return typeof value['exitCode'] === 'number' && hasStreamFields(value)
        ? (value as unknown as RunPythonDisplayResult)
        : null;
    case 'timed_out':
      return typeof value['timeoutMs'] === 'number' &&
        isSignalField(value['signal']) &&
        hasStreamFields(value)
        ? (value as unknown as RunPythonDisplayResult)
        : null;
    case 'killed':
      return isSignalField(value['signal']) && hasStreamFields(value)
        ? (value as unknown as RunPythonDisplayResult)
        : null;
    case 'cancelled':
      // The omitted-byte fields are validated here too (every stream-carrying
      // arm is): forwarding an undefined count into the pane would defeat its
      // "nothing to show" early-return and render bare labels over nothing.
      return typeof value['partialStdout'] === 'string' &&
        typeof value['partialStderr'] === 'string' &&
        hasOmittedByteFields(value)
        ? (value as unknown as RunPythonDisplayResult)
        : null;
    case 'network_denied':
      return Array.isArray(value['deniedDomains']) &&
        value['deniedDomains'].every((domain) => typeof domain === 'string')
        ? (value as unknown as RunPythonDisplayResult)
        : null;
    case 'unavailable':
      return typeof value['reason'] === 'string' && typeof value['detail'] === 'string'
        ? (value as unknown as RunPythonDisplayResult)
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
