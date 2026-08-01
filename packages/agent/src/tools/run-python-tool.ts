import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  type CodeExecutorHostCapabilities,
  type ExecPolicy,
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
  | 'no_sandbox_configured';

/**
 * The model-facing result. A discriminated union rather than a flat object
 * with nullable fields: `exitCode` exists ONLY on `completed`, so it is
 * impossible to render `0` for a signal-terminated run — the failure mode the
 * seam's `exitCode: number | null` convention exists to prevent.
 * Mirrors the BST-1070 design spec §4.2, minus the `network_denied` and
 * `policy_changed` arms, which belong to the not-yet-buildable network
 * escalation (see the tool doc comment).
 */
export type RunPythonResult =
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
    }
  | {
      readonly detail: string;
      readonly kind: 'unavailable';
      readonly reason: RunPythonUnavailableReason;
    };

const RunPythonOutputSchema = z.custom<RunPythonResult>();

interface ProjectedStreams {
  readonly stderr: string;
  readonly stderrOmittedBytes: number;
  readonly stdout: string;
  readonly stdoutOmittedBytes: number;
}

/**
 * Fits captured output to the model's char budget, ADDING anything trimmed
 * here to the executor's own omitted-byte counts. Both layers drop bytes, and
 * a count that reported only one of them would understate the loss.
 * The TAIL is kept: a traceback ends with the exception.
 */
export function projectRunPythonStreams(result: ExecResult): ProjectedStreams {
  const budget = Math.max(0, NATIVE_TOOL_RESULT_CHAR_BUDGET - OUTPUT_ENVELOPE_CHARS);
  const stdoutBudget = result.stderr.length > 0 ? Math.floor(budget * 0.6) : budget;
  const stderrBudget = result.stdout.length > 0 ? budget - stdoutBudget : budget;
  const stdoutDropped = Math.max(0, result.stdout.length - stdoutBudget);
  const stderrDropped = Math.max(0, result.stderr.length - stderrBudget);
  return {
    stderr: stderrDropped > 0 ? result.stderr.slice(-stderrBudget) : result.stderr,
    stderrOmittedBytes: result.stderrOmittedBytes + stderrDropped,
    stdout: stdoutDropped > 0 ? result.stdout.slice(-stdoutBudget) : result.stdout,
    stdoutOmittedBytes: result.stdoutOmittedBytes + stdoutDropped,
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
      const signal = context?.abortSignal ?? new AbortController().signal;

      let executor: ReturnType<typeof resolveCodeExecutor>;
      try {
        const host = await options.resolveHost(signal);
        executor = resolveCodeExecutor('fence', host);
      } catch (error) {
        return toUnavailableResult(error);
      }

      const scratchDir = await createScratchDir();
      const policy: ExecPolicy = {
        // Empty and unreachable from input: see the doc comment above.
        allowedDomains: [],
        allowWrite: [scratchDir],
      };
      try {
        const result = await executor.execute({
          code: parsed.code,
          language: 'python',
          maxOutputBytes: RUN_PYTHON_MAX_OUTPUT_BYTES,
          policy,
          scratchDir,
          signal,
          timeoutMs,
        });
        return toRunPythonResult(result, timeoutMs);
      } catch (error) {
        if (isExecAbortedError(error)) {
          // Cancellation is reported AS cancellation, carrying whatever the
          // script printed first — never an empty success (which would imply
          // the work completed) and never an empty card (which would imply
          // nothing happened).
          return {
            kind: 'cancelled',
            partialStderr: error.partialStderr,
            partialStdout: error.partialStdout,
          };
        }
        return toUnavailableResult(error);
      } finally {
        // The caller owns executor lifetime: each resolveCodeExecutor call
        // constructs a new one.
        await executor.dispose().catch(() => undefined);
        await fsPromises.rm(scratchDir, { force: true, recursive: true }).catch(() => undefined);
      }
    },
    id: RUN_PYTHON_TOOL_ID,
    inputSchema: RunPythonInputSchema,
    outputSchema: RunPythonOutputSchema,
  });
}
