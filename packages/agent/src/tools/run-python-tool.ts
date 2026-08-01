import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/utils/logger';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
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
import { NATIVE_TOOL_RESULT_CHAR_BUDGET } from '../stream/tool-output-limits';
import { RunPythonInputSchema } from './schemas';

const logger = createLogger('RunPythonTool');

export const RUN_PYTHON_TOOL_ID = NATIVE_TOOL_ID.runPython;

/** Matches the display schema's documented default; the seam caps at MAX_EXEC_TIMEOUT_MS. */
export const RUN_PYTHON_DEFAULT_TIMEOUT_MS = 30_000;

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

export type RunPythonUnavailableReason =
  | 'executor_kind_unavailable'
  | 'executor_tier_mismatch'
  | 'interpreter_unavailable'
  | 'language_unsupported'
  | 'network_unsupported'
  | 'no_sandbox_configured'
  | 'resolve_timed_out';

/**
 * The model-facing result. A discriminated union rather than a flat object
 * with nullable fields: `exitCode` exists ONLY on `completed`, so it is
 * impossible to render `0` for a signal-terminated run — the failure mode the
 * seam's `exitCode: number | null` convention exists to prevent.
 * Mirrors the BST-1070 design spec §4.2, minus the `network_denied` and
 * `policy_changed` arms, which belong to the not-yet-buildable network
 * escalation (see the tool doc comment).
 */
export type RunPythonResult = (
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
      /**
       * False when the abort landed while still QUEUED — nothing spawned, so
       * no side effects. True means killed mid-run, with possible partial
       * ones. The seam carries this precisely so the two are distinguishable.
       */
      readonly processStarted: boolean;
      readonly stderrOmittedBytes: number;
      readonly stdoutOmittedBytes: number;
    }
  | {
      readonly detail: string;
      readonly kind: 'unavailable';
      readonly reason: RunPythonUnavailableReason;
    }
) &
  RunPythonScratchCleanupNote;

/**
 * Rides every arm. Present ONLY when the per-call scratch dir could not be
 * removed (sandboxed code can `chmod(0)` a nested dir). Silently returning
 * success there would contradict the tool's own guarantee that nothing it
 * writes persists, so the failure is surfaced and logged, never swallowed.
 */
export interface RunPythonScratchCleanupNote {
  readonly scratchCleanupFailed?: true;
  readonly scratchDir?: string;
}

const RunPythonOutputSchema = z.custom<RunPythonResult>();

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
  const { stderrBudget, stdoutBudget } = splitStreamBudget(
    budget,
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

/**
 * `run_python` — runs agent-authored Python inside the OS fence (BST-1067).
 *
 * **Network is structurally absent, not defaulted off.** The input schema has
 * no domain field and `policy.allowedDomains` is a frozen empty array, so no
 * call can request egress. That is deliberate: the network escalation (the
 * BST-1070 design's "Gate B") rides the suspension channel, and suspensions
 * are NOT rediscovered across a renderer reload — a reload while the prompt
 * was on screen would strand the run silently. Shipping the escalation before
 * that gap is closed would add exactly the kind of silent path this codebase
 * refuses, so network stays inexpressible until then.
 *
 * Registered as the factory-returned Mastra Tool object (never re-wrapped in
 * the desktop registry's `{description, execute, id, inputSchema}` literal),
 * which is also what BST-1070 will need once it adds `suspendSchema` — the
 * literal shape silently drops it.
 */
export function createRunPythonTool(options: RunPythonToolOptions) {
  return createTool({
    description: TOOL_DESCRIPTIONS[RUN_PYTHON_TOOL_ID],
    execute: async (input, context): Promise<RunPythonResult> => {
      const parsed = RunPythonInputSchema.parse(input);
      const timeoutMs = parsed.timeoutMs ?? RUN_PYTHON_DEFAULT_TIMEOUT_MS;
      // The seam REQUIRES a real AbortSignal so user Stop kills the process
      // tree. A run without one would leave Python executing until timeoutMs.
      const callerSignal = context?.abortSignal ?? new AbortController().signal;
      // ONE budget spans resolve + execute. Resolving is slow on a cold first
      // run (hashing and unpacking the bundled CPython), and bounding only the
      // execute half would let a call the model capped at 30s spend far longer
      // resolving and then receive a FRESH 30s to run.
      const startedAt = Date.now();
      const resolveSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]);

      let executor: ReturnType<typeof resolveCodeExecutor>;
      try {
        const host = await options.resolveHost(resolveSignal);
        executor = resolveCodeExecutor('fence', host);
      } catch (error) {
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
              // Empty and unreachable from input: see the doc comment above.
              allowedDomains: [],
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
    outputSchema: RunPythonOutputSchema,
  });
}
