import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import { Schema } from 'effect';
import {
  type CodeExecutorHostCapabilities,
  type ExecResult,
  isExecAbortedError,
  isExecCapabilityMismatchError,
  isExecutorKindUnavailableError,
  isExecutorTierMismatchError,
  isNoSandboxConfiguredError,
  MAX_EXEC_OUTPUT_BYTES,
  resolveCodeExecutor,
} from '../code-execution';
import { isFenceReadinessError } from '../fence/fence-readiness-error';
import type { HostToolExecutionContext } from '../host-tool-definition';
import { NATIVE_TOOL_RESULT_CHAR_BUDGET } from '../stream/tool-output-limits';
// Single source with the approval-context derivation (BST-1070): the timeout
// the card displays and the timeout this tool enforces must be the same
// constant, or the approval card would state terms the run does not honour.
import { RUN_PYTHON_DEFAULT_TIMEOUT_MS } from './run-python-approval-context';
import { type RunPythonInput, RunPythonInputSchema } from './schemas';
import { resolveGuardedToolSignal } from './tool-guard-deadline';

const logger = createLogger('RunPythonTool');

/**
 * Re-parse the model's input through the registered schema, throwing on a
 * violation as the previous `.parse` did. Read through the producer-neutral
 * accessor so the input schema's authoring library stays this module's
 * business: it is Effect-authored (ADR-0004), and the accessor keeps the
 * provider-`null` normalization that reaches the wire.
 */
function parseRunPythonInput(input: unknown): RunPythonInput {
  const result = validateToolInputValue(RunPythonInputSchema, input);
  if (!result.success) {
    throw new Error(
      `invalid run_python input — ${result.issues
        .map(
          (issue) =>
            `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`
        )
        .join('; ')}`
    );
  }
  return result.value as RunPythonInput;
}

export const RUN_PYTHON_TOOL_ID = NATIVE_TOOL_ID.runPython;

export { RUN_PYTHON_DEFAULT_TIMEOUT_MS } from './run-python-approval-context';

/**
 * Room reserved for the result envelope (kind, exit code, omitted-byte counts)
 * so a self-bounded result never tips the transport guard. Same reservation
 * shape `run-skill-script-tool.ts` and `execute-command-tool.ts` use.
 */
const OUTPUT_ENVELOPE_CHARS = 1200;

/**
 * Byte bound handed to the EXECUTOR. Deliberately far larger than the model's
 * char budget: the executor bound exists to stop a runaway loop exhausting
 * memory, while the model projection below is what fits the context window.
 * Collapsing them would make `stdoutOmittedBytes` report the projection's
 * trimming rather than the capture's, so the model could not tell "the script
 * produced 4 MB" from "we showed you the last 10 KB of it".
 */
const RUN_PYTHON_MAX_OUTPUT_BYTES = Math.min(4 * 1024 * 1024, MAX_EXEC_OUTPUT_BYTES);

const RunPythonUnavailableReasonSchema = Schema.Literals([
  'sandbox_dependencies_missing',
  'sandbox_namespace_blocked',
  'sandbox_unsupported_runtime',
  'sandbox_readiness_timeout',
  'sandbox_readiness_failed',
  'approval_confirmation_unavailable',
  'executor_kind_unavailable',
  'executor_tier_mismatch',
  'interpreter_unavailable',
  'language_unsupported',
  'network_confirmation_unavailable',
  'network_unsupported',
  'no_sandbox_configured',
  'resolve_timed_out',
  'resume_unrecognized',
]);
export type RunPythonUnavailableReason = typeof RunPythonUnavailableReasonSchema.Type;

/** A cleanup failure rides every result arm so the remaining scratch directory is visible. */
const scratchCleanupFields = {
  scratchCleanupFailed: Schema.optional(Schema.Literal(true)),
  scratchDir: Schema.optional(Schema.String),
};
export type RunPythonScratchCleanupNote = Schema.Struct.Type<typeof scratchCleanupFields>;
const streamFields = {
  stderr: Schema.String,
  stderrOmittedBytes: Schema.Finite,
  stdout: Schema.String,
  stdoutOmittedBytes: Schema.Finite,
};
/** Model-facing result: signal termination cannot masquerade as a successful exit code. */
export const RunPythonResultSchema = Schema.Union(
  [
    Schema.Struct({
      ...scratchCleanupFields,
      ...streamFields,
      exitCode: Schema.Finite,
      kind: Schema.Literal('completed'),
    }),
    Schema.Struct({
      ...scratchCleanupFields,
      ...streamFields,
      kind: Schema.Literal('timed_out'),
      signal: Schema.NullOr(Schema.String),
      timeoutMs: Schema.Finite,
    }),
    Schema.Struct({
      ...scratchCleanupFields,
      ...streamFields,
      kind: Schema.Literal('killed'),
      signal: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      ...scratchCleanupFields,
      kind: Schema.Literal('cancelled'),
      partialStderr: Schema.String,
      partialStdout: Schema.String,
      processStarted: Schema.Boolean,
      stderrOmittedBytes: Schema.Finite,
      stdoutOmittedBytes: Schema.Finite,
    }),
    Schema.Struct({
      ...scratchCleanupFields,
      deniedDomains: Schema.Array(Schema.String),
      kind: Schema.Literal('network_denied'),
    }),
    Schema.Struct({ ...scratchCleanupFields, kind: Schema.Literal('declined') }),
    Schema.Struct({
      ...scratchCleanupFields,
      detail: Schema.String,
      kind: Schema.Literal('unavailable'),
      reason: RunPythonUnavailableReasonSchema,
    }),
  ],
  { mode: 'oneOf' }
);
export type RunPythonResult = typeof RunPythonResultSchema.Type;

interface ProjectedStreams {
  readonly stderr: string;
  readonly stderrOmittedBytes: number;
  readonly stdout: string;
  readonly stdoutOmittedBytes: number;
}

/**
 * Keeps the LAST `maxCodePoints` code points. A traceback ends with the
 * exception, so the tail is what matters. Code-point-aware on purpose:
 * `String.slice(-n)` cuts on UTF-16 code units and can leave a lone surrogate
 * at the boundary, which is not encodable as UTF-8 and breaks JSON
 * serialization on the way to the provider. `run_python` is pitched at data
 * wrangling, so emoji/CJK/astral output is routine.
 */
export function sliceTailCodePoints(value: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) {
    return '';
  }
  const codePoints = Array.from(value);
  if (codePoints.length <= maxCodePoints) {
    return value;
  }
  return codePoints.slice(codePoints.length - maxCodePoints).join('');
}

/**
 * Splits the budget by DEMAND, not by presence. Keying the split on
 * `length > 0` meant one stray newline on stderr — which Python emits
 * constantly for warnings — moved ~3,900 characters away from a stdout the
 * model actually needed, and the traceback-heavy case (one line printed, then
 * a crash) handed the traceback the SMALLER half. Here each stream takes what
 * it needs and only a genuinely contested remainder is divided, so neither
 * stream ends up with less than the presence-based split gave it.
 */
function splitStreamBudget(
  budget: number,
  stdoutLength: number,
  stderrLength: number
): { stderrBudget: number; stdoutBudget: number } {
  if (stdoutLength + stderrLength <= budget) {
    return { stderrBudget: stderrLength, stdoutBudget: stdoutLength };
  }
  const stdoutShare = Math.floor(budget * 0.6);
  const stderrShare = budget - stdoutShare;
  if (stdoutLength <= stdoutShare) {
    return { stderrBudget: budget - stdoutLength, stdoutBudget: stdoutLength };
  }
  if (stderrLength <= stderrShare) {
    return { stderrBudget: stderrLength, stdoutBudget: budget - stderrLength };
  }
  return { stderrBudget: stderrShare, stdoutBudget: stdoutShare };
}

/**
 * How much of the budget JSON escaping will consume for this output. Measured
 * on the portion that would actually be kept, so plain ASCII pays nothing and
 * escape-heavy output pays what it really costs. Shared with runSkillScript's
 * output fit, which must uphold the same serialized self-bound contract.
 */
export function serializationOverhead(stdout: string, stderr: string, budget: number): number {
  const sampleStdout = sliceTailCodePoints(stdout, budget);
  const sampleStderr = sliceTailCodePoints(stderr, budget);
  const raw = sampleStdout.length + sampleStderr.length;
  if (raw === 0) {
    return 0;
  }
  // -2 per string drops the quotes JSON.stringify adds around each.
  const serialized =
    JSON.stringify(sampleStdout).length - 2 + (JSON.stringify(sampleStderr).length - 2);
  return Math.max(0, Math.min(budget, serialized - raw));
}

/**
 * Fits captured output to the model's char budget, ADDING anything trimmed
 * here to the executor's own omitted-byte counts. Both layers drop output, and
 * a count reporting only one would understate the loss.
 *
 * The added figure is measured in UTF-8 BYTES, matching what the executor
 * counts (it sums `chunk.length` over Buffers). Mixing UTF-16 code units into
 * that field misreports multi-byte output by up to 3-4x — exactly the
 * "produced 4 MB vs shown the last 10 KB" signal this field exists for.
 */
export function projectRunPythonStreams(result: {
  readonly stderr: string;
  readonly stderrOmittedBytes: number;
  readonly stdout: string;
  readonly stdoutOmittedBytes: number;
}): ProjectedStreams {
  const budget = Math.max(0, NATIVE_TOOL_RESULT_CHAR_BUDGET - OUTPUT_ENVELOPE_CHARS);
  // Fit against the SERIALIZED size, not raw length. Output full of quotes,
  // backslashes, or control characters — a script printing JSON, which is a
  // routine run_python workload — nearly doubles under JSON.stringify, so a
  // raw-length fit can still cross the transport threshold and turn a result
  // that was supposed to be self-bounded into an oversized-output failure.
  const serializedBudget = Math.max(
    0,
    budget - serializationOverhead(result.stdout, result.stderr, budget)
  );
  const { stderrBudget, stdoutBudget } = splitStreamBudget(
    serializedBudget,
    result.stdout.length,
    result.stderr.length
  );
  const stdout = sliceTailCodePoints(result.stdout, stdoutBudget);
  const stderr = sliceTailCodePoints(result.stderr, stderrBudget);
  return {
    stderr,
    stderrOmittedBytes:
      result.stderrOmittedBytes +
      (Buffer.byteLength(result.stderr, 'utf8') - Buffer.byteLength(stderr, 'utf8')),
    stdout,
    stdoutOmittedBytes:
      result.stdoutOmittedBytes +
      (Buffer.byteLength(result.stdout, 'utf8') - Buffer.byteLength(stdout, 'utf8')),
  };
}

/**
 * Maps a settled `ExecResult` onto the result union.
 *
 * `killed` is a REAL state, not a defensive branch: the seam says `exitCode`
 * is null "exactly when the process was terminated by a signal — INCLUDING a
 * timeout kill", so a segfaulting C extension or the OOM killer lands here
 * with `timedOut: false`. Folding it into `completed` would report a green
 * exit for a crashed script; folding it into `unavailable` would claim
 * nothing ran when output was already produced.
 */
export function toRunPythonResult(result: ExecResult, timeoutMs: number): RunPythonResult {
  const streams = projectRunPythonStreams(result);
  if (result.exitCode !== null) {
    return { exitCode: result.exitCode, kind: 'completed', ...streams };
  }
  if (result.timedOut) {
    return { kind: 'timed_out', signal: result.signal, timeoutMs, ...streams };
  }
  return { kind: 'killed', signal: result.signal, ...streams };
}

/**
 * Maps a thrown seam error onto an `unavailable` result. Anything
 * unrecognised RETHROWS rather than being labelled: a diagnosis this code
 * cannot actually make is worse than a surfaced error.
 */
function toUnavailableResult(error: unknown): RunPythonResult {
  if (isNoSandboxConfiguredError(error)) {
    return {
      detail: 'No code-execution sandbox is configured on this machine.',
      kind: 'unavailable',
      reason: 'no_sandbox_configured',
    };
  }
  if (isExecutorKindUnavailableError(error)) {
    return {
      detail: error.message,
      kind: 'unavailable',
      reason: 'executor_kind_unavailable',
    };
  }
  if (isExecutorTierMismatchError(error)) {
    return {
      detail: error.message,
      kind: 'unavailable',
      reason: 'executor_tier_mismatch',
    };
  }
  if (isExecCapabilityMismatchError(error)) {
    return { detail: error.message, kind: 'unavailable', reason: error.reason };
  }
  if (isFenceReadinessError(error)) {
    return { detail: error.message, kind: 'unavailable', reason: error.reason };
  }
  if (isInterpreterUnavailableError(error)) {
    return {
      detail: error.message,
      kind: 'unavailable',
      reason: 'interpreter_unavailable',
    };
  }
  throw error;
}

/**
 * A `python_*`-coded error from the bundled-interpreter resolver (BST-1061).
 * Matched structurally rather than by importing the desktop module: this
 * package must not depend on `apps/desktop`, and the seam's own error codes
 * are all `exec_*`/`executor_*`/`fence_*`, so the prefix cannot collide.
 */
function isInterpreterUnavailableError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) {
    return false;
  }
  const code: unknown = (error as unknown as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('python_');
}

/**
 * The per-call scratch directory: the ONLY writable path, created fresh and
 * removed in a `finally` so nothing a script writes outlives the call.
 * Lives under `os.tmpdir()`, so an orphan left by a hard crash is reaped by
 * the OS rather than accumulating in userData.
 */
async function createScratchDir(): Promise<string> {
  const scratchDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-run-python-'));
  // macOS resolves /var → /private/var, and the seam compares REALPATHS for
  // scratchDir ⊆ allowWrite. Handing over the unresolved spelling fails that
  // containment check as a validation error.
  return await fsPromises.realpath(scratchDir);
}

/**
 * Removes the per-call scratch dir, retrying once. Sandboxed code can leave a
 * nested directory unreadable (`chmod(0)`), and `rm -r` then fails. Returns
 * the note to attach to the result: the tool advertises that nothing it writes
 * persists, so a failure here has to be visible rather than swallowed.
 */
async function removeScratchDir(scratchDir: string): Promise<RunPythonScratchCleanupNote> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsPromises.rm(scratchDir, { force: true, maxRetries: 2, recursive: true });
      return {};
    } catch (error) {
      if (attempt === 1) {
        logger.error('run_python could not delete its scratch directory', {
          error: error instanceof Error ? error.message : String(error),
          scratchDir,
        });
        return { scratchCleanupFailed: true, scratchDir };
      }
      await fsPromises.chmod(scratchDir, 0o700).catch(() => undefined);
    }
  }
  return {};
}

/** The narrowed resume shapes execute() dispatches on. */
type RunPythonResume =
  | { readonly kind: 'none' }
  | { readonly action: 'allow' | 'deny'; readonly kind: 'network' }
  | { readonly kind: 'unrecognized' };

/** A decision is host context, never part of model arguments. Unknown shapes refuse. */
function readRunPythonResume(resume: unknown): RunPythonResume {
  if (resume === undefined) {
    return { kind: 'none' };
  }
  if (resume !== null && typeof resume === 'object' && !Array.isArray(resume)) {
    const keys = Reflect.ownKeys(resume);
    const record = resume as { action?: unknown; approved?: unknown };
    const riderOnly =
      keys.length === 2 && Object.hasOwn(resume, 'approved') && record.approved === true;
    if (
      (keys.length === 1 || riderOnly) &&
      Object.hasOwn(resume, 'action') &&
      (record.action === 'allow' || record.action === 'deny')
    ) {
      return { action: record.action, kind: 'network' };
    }
  }
  return { kind: 'unrecognized' };
}

/** The host owns permission admission and per-call network consent. */
function networkDecision(
  requestedDomains: readonly string[],
  resumeData: unknown
):
  | { readonly kind: 'run'; readonly networkGranted: boolean }
  | { readonly kind: 'settled'; readonly result: RunPythonResult } {
  const resume = readRunPythonResume(resumeData);
  if (resume.kind === 'unrecognized') {
    return {
      kind: 'settled',
      result: {
        detail: 'The host network decision could not be read.',
        kind: 'unavailable',
        reason: 'resume_unrecognized',
      },
    };
  }
  if (resume.kind === 'network' && resume.action === 'deny') {
    return { kind: 'settled', result: { deniedDomains: requestedDomains, kind: 'network_denied' } };
  }
  const networkGranted =
    resume.kind === 'network' && resume.action === 'allow' && requestedDomains.length > 0;
  if (requestedDomains.length > 0 && !networkGranted) {
    return {
      kind: 'settled',
      result: {
        detail: 'The host has not confirmed network access for this call.',
        kind: 'unavailable',
        reason: 'network_confirmation_unavailable',
      },
    };
  }
  return { kind: 'run', networkGranted };
}

export interface RunPythonToolOptions {
  /**
   * Resolves the host's executor capabilities for THIS call. Async because the
   * bundled CPython (BST-1061) may still need a first-run unpack, and because
   * an interpreter that cannot be produced must surface as a typed
   * `interpreter_unavailable` — distinguishable from `no_sandbox_configured`,
   * so the user is told which half is missing rather than a generic failure.
   * `fence` absent ⇒ every call is `unavailable`.
   */
  readonly resolveHost: (signal?: AbortSignal) => Promise<CodeExecutorHostCapabilities>;
}

/** Execute only host-admitted Python; nonempty domains require the host's per-call consent. */
export function createRunPythonTool(options: RunPythonToolOptions) {
  return {
    description: TOOL_DESCRIPTIONS[RUN_PYTHON_TOOL_ID],
    execute: async (
      input: RunPythonInput,
      context?: HostToolExecutionContext
    ): Promise<RunPythonResult> => {
      const parsed = parseRunPythonInput(input);
      // Deduplicated at the SOURCE so the suspend payload, the escalation
      // card's checkbox list (keyed by domain), and ExecPolicy.allowedDomains
      // all agree — a repeated host is harmless intent, not a reason to fail.
      const requestedDomains = [...new Set(parsed.allowedDomains ?? [])];

      const gateOutcome = networkDecision(requestedDomains, context?.resumeData);
      if (gateOutcome.kind === 'settled') {
        return gateOutcome.result;
      }
      const { networkGranted } = gateOutcome;

      const timeoutMs = parsed.timeoutMs ?? RUN_PYTHON_DEFAULT_TIMEOUT_MS;
      // The seam REQUIRES a real AbortSignal so user Stop kills the process
      // tree. A run without one would leave Python executing until timeoutMs.
      const callerSignal = resolveGuardedToolSignal(context) ?? new AbortController().signal;
      // ONE budget spans resolve + execute. Resolving is slow on a cold first
      // run (hashing and unpacking the bundled CPython), and bounding only the
      // execute half would let a call the model capped at 30s spend far longer
      // resolving and then receive a FRESH 30s to run.
      const startedAt = Date.now();
      const resolveSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);

      let executor: Awaited<ReturnType<typeof resolveCodeExecutor>>;
      try {
        const host = await options.resolveHost(resolveSignal);
        executor = await resolveCodeExecutor('fence', host, resolveSignal);
      } catch (error) {
        // Only the failure belonging to this resolution signal is an abort.
        // An unrelated construction error must remain visible even if Stop
        // or the shared deadline happened to fire at the same time.
        if (resolveSignal.aborted && error === resolveSignal.reason) {
          if (callerSignal.aborted) {
            return {
              kind: 'cancelled',
              partialStderr: '',
              partialStdout: '',
              processStarted: false,
              stderrOmittedBytes: 0,
              stdoutOmittedBytes: 0,
            };
          }
          return {
            detail: `Resolving the Python sandbox used the whole ${timeoutMs}ms budget, so the code was not run.`,
            kind: 'unavailable',
            reason: 'resolve_timed_out',
          };
        }
        return toUnavailableResult(error);
      }

      let scratchDir: string | undefined;
      let cleanupNote: RunPythonScratchCleanupNote = {};
      // The cleanup note has to ride the RETURNED value and a `finally` cannot
      // alter one, so the run is wrapped and the note merged afterwards.
      const runInSandbox = async (): Promise<RunPythonResult> => {
        try {
          // INSIDE the try: creating this before it meant a failing
          // mkdtemp/realpath (ENOSPC, a hardened TMPDIR) escaped without ever
          // disposing the executor. That leak is PROCESS-GLOBAL, not per-call
          // — createFenceExecutor increments a module-level session count that
          // only dispose() decrements, and only reaching zero resets the srt
          // sandbox manager.
          scratchDir = await createScratchDir();
          const remainingMs = timeoutMs - (Date.now() - startedAt);
          if (remainingMs <= 0) {
            return {
              detail: `Resolving the Python sandbox used the whole ${timeoutMs}ms budget, so the code was not run.`,
              kind: 'unavailable',
              reason: 'resolve_timed_out',
            };
          }
          const result = await executor.execute({
            code: parsed.code,
            language: 'python',
            maxOutputBytes: RUN_PYTHON_MAX_OUTPUT_BYTES,
            policy: {
              // Non-empty ONLY on a Gate B allow-resumed leg; every other
              // path (offline call, deny, junk resume) stays [].
              allowedDomains: networkGranted ? requestedDomains : [],
              allowWrite: [scratchDir],
            },
            scratchDir,
            signal: callerSignal,
            timeoutMs: remainingMs,
          });
          return toRunPythonResult(result, timeoutMs);
        } catch (error) {
          if (isExecAbortedError(error)) {
            // Cancellation is reported AS cancellation, carrying whatever the
            // script printed first — never an empty success (which implies the
            // work completed) and never an empty card (which implies nothing
            // happened). Bounded through the SAME projection as every other
            // arm: these partials come straight off the fence's captures,
            // bounded only by maxOutputBytes, so returning them raw could hand
            // back megabytes and trip the transport guard — losing the partial
            // output entirely, the exact outcome this arm exists to prevent.
            const streams = projectRunPythonStreams({
              stderr: error.partialStderr,
              stderrOmittedBytes: error.stderrOmittedBytes,
              stdout: error.partialStdout,
              stdoutOmittedBytes: error.stdoutOmittedBytes,
            });
            return {
              kind: 'cancelled',
              partialStderr: streams.stderr,
              partialStdout: streams.stdout,
              processStarted: error.processStarted,
              stderrOmittedBytes: streams.stderrOmittedBytes,
              stdoutOmittedBytes: streams.stdoutOmittedBytes,
            };
          }
          return toUnavailableResult(error);
        } finally {
          // The caller owns executor lifetime: each resolveCodeExecutor call
          // constructs a new one.
          await executor.dispose().catch((error: unknown) => {
            logger.error('run_python failed to dispose its executor', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          if (scratchDir) {
            cleanupNote = await removeScratchDir(scratchDir);
          }
        }
      };

      const result = await runInSandbox();
      return { ...result, ...cleanupNote };
    },
    id: RUN_PYTHON_TOOL_ID,
    inputSchema: RunPythonInputSchema,
  };
}
