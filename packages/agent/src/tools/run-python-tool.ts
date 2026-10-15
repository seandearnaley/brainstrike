import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { validateToolInputValue } from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import type { RunPythonNetworkSuspendPayload } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
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
import { type FenceReadinessReason, isFenceReadinessError } from '../fence/fence-readiness-error';
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

export type RunPythonUnavailableReason =
  | FenceReadinessReason
  | 'approval_confirmation_unavailable'
  | 'executor_kind_unavailable'
  | 'executor_tier_mismatch'
  | 'interpreter_unavailable'
  | 'language_unsupported'
  | 'network_confirmation_unavailable'
  | 'network_unsupported'
  | 'no_sandbox_configured'
  | 'resolve_timed_out'
  | 'resume_unrecognized';

/**
 * The model-facing result. A discriminated union rather than a flat object
 * with nullable fields: `exitCode` exists ONLY on `completed`, so it is
 * impossible to render `0` for a signal-terminated run — the failure mode the
 * seam's `exitCode: number | null` convention exists to prevent.
 * Mirrors the BST-1070 design spec §4.2 (the `policy_changed` arm stays
 * deferred with the fingerprint enforcement — see the design doc's status
 * header).
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
      /** The exact domains the user declined. The model can rewrite offline. */
      readonly deniedDomains: readonly string[];
      readonly kind: 'network_denied';
    }
  | {
      /**
       * LEGACY (pre-@mastra/core-1.56 history only): the user declined Gate A
       * back when the tool raised its own approval suspension and reported
       * the decline itself. Since the 1.56 approval rework Gate A is the
       * framework's pre-execution gate; a decline never reaches execute() and
       * produces NO tool result — the approval card's "Declined" state owns
       * the UX, identical to every other ask-gated tool. This arm stays only
       * so threads persisted before the rework keep rendering their declined
       * result panes.
       */
      readonly kind: 'declined';
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

/**
 * Suspend/resume transport schemas for Gate B (BST-1070; Gate A moved to the
 * framework's pre-execution approval at the @mastra/core 1.56 rework — the
 * permission gate's per-tool `requireApproval` clone raises the ordinary
 * `tool-call-approval` pause BEFORE execute() runs, so no approval suspension
 * exists in-tool any more). The tool wrapper validates every `suspend()`
 * payload against the suspend schema and every incoming resume against the
 * resume schema.
 *
 * - Gate B (network): payload mirrors {@link RunPythonNetworkSuspendPayload};
 *   resume mirrors `RunPythonNetworkDecision` from the contract, plus an
 *   OPTIONAL `approved: true` rider. The rider is the 1.56+ contract for
 *   resuming ANY suspension of an approval-gated tool: Mastra re-checks the
 *   gate on every resume leg and converts a resume without `approved: true`
 *   into its generic denial before execute() runs. The repo's resume
 *   transport attaches it for ask-gated tools (`attempt-legs.ts`,
 *   `createToolResumeTurnAttempt`); it is a statement of fact — the call WAS
 *   approved at its pre-execution gate.
 */
const RunPythonNetworkSuspendSchema = z
  .object({
    allowedDomains: z.array(z.string().min(1)).min(1),
    kind: z.literal('network'),
  })
  .strict();

const RunPythonSuspendSchema = RunPythonNetworkSuspendSchema;

const RunPythonNetworkResumeSchema = z
  .object({ action: z.enum(['allow', 'deny']), approved: z.literal(true).optional() })
  .strict();

const RunPythonResumeSchema = RunPythonNetworkResumeSchema;

/** The narrowed resume shapes execute() dispatches on. */
type RunPythonResume =
  | { readonly kind: 'none' }
  | { readonly action: 'allow' | 'deny'; readonly kind: 'network' }
  | { readonly kind: 'unrecognized' };

/**
 * Narrows the resume data to the Gate B answer, strictly: the `action` key
 * with an exact value, optionally accompanied by the 1.56+ `approved: true`
 * rider (see the schema comment) and NOTHING else. Mastra already validates
 * against {@link RunPythonResumeSchema}, but this layer must fail SAFE on its
 * own — a schema drift or a hand-crafted resume must never become a silent
 * network grant (design §3.1), so anything else is `unrecognized` and the
 * caller denies the pending gate. A bare `{approved: boolean}` is DELIBERATELY
 * unrecognized here: since the 1.56 rework the framework consumes approval
 * resumes before execute(), so one arriving in-tool is a drifted shape.
 */
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

interface RunPythonAgentContext {
  readonly resumeData?: unknown;
  readonly suspend?: (payload: unknown, suspendOptions?: unknown) => Promise<unknown>;
}

/** What the serial gate pass decided: run, stop with a result, or pause. */
type RunPythonGateOutcome =
  | { readonly kind: 'run'; readonly networkGranted: boolean }
  | { readonly kind: 'settled'; readonly result: RunPythonResult }
  | { readonly kind: 'suspended' };

/**
 * The SERIAL two-gate pass under the @mastra/core 1.56+ approval idiom
 * (BST-1070 §3.1 + BST-1097, mechanism re-based at the ^1.57 adoption).
 * `suspend()` returns Promise<void> and never resolves to the decision:
 * Mastra re-runs execute from the top with the answer in
 * `context.agent.resumeData` (the `createAskUserTool` control flow). Every
 * pause fires BEFORE the host is resolved — no executor, no scratch dir,
 * nothing to leak if the run is never resumed.
 *
 * Gate A — "may this code run at all?" (BST-1097) — is the FRAMEWORK's
 * pre-execution approval: under an 'ask' policy the permission gate registers
 * this tool as a `requireApproval` clone (permission-tool-gate.ts, the same
 * idiom as every other ask-gated tool), Mastra emits the ordinary
 * `tool-call-approval` chunk before execute() runs, approve consumes the
 * answer and runs the tool, decline never reaches the tool (the framework
 * mints the denial and streams NO tool result — the approval card's
 * "Declined" state owns the UX, as for every other ask-gated tool; the typed
 * `declined` arm below is legacy, for pre-rework persisted threads only).
 * execute() itself only guards the DIRECT-invocation hole: 'ask'
 * with no suspension channel refuses rather than running unprompted.
 *
 * Gate B — "may it reach these specific domains?" (BST-1070 §3.1) — stays a
 * PLAIN suspension raised in here: per-call, argument-aware, and structurally
 * ungrantable (the plain suspension channel has no grant surface, so no
 * session grant, per-tool override, or yolo posture ever pre-answers it).
 * Its resume carries `{action}` plus the 1.56+ `approved: true` rider the
 * resume transport attaches for approval-gated tools — without the rider
 * Mastra's per-leg re-check converts the resume into a denial before this
 * code runs (the pre-1.56 reason the flag was forbidden here; the rider is
 * what makes flag + suspension compose now). A network answer can only exist
 * for a call whose Gate B suspension was raised, which only happens after
 * Gate A settled; the suspend-resume transport additionally refuses to
 * deliver a generic resume to an approval pause
 * (`assertResumedCallIsSuspendPause`), so the shapes cannot leapfrog.
 */
async function passRunPythonGates(params: {
  readonly agentContext: RunPythonAgentContext | undefined;
  readonly requestedDomains: readonly string[];
  readonly resolveApprovalDecision: () => 'allow' | 'ask';
  readonly resumeData: unknown;
}): Promise<RunPythonGateOutcome> {
  const { agentContext, requestedDomains, resolveApprovalDecision } = params;
  const resume = readRunPythonResume(params.resumeData);

  let networkGranted = false;
  switch (resume.kind) {
    case 'none': {
      if (resolveApprovalDecision() === 'ask' && !agentContext?.suspend) {
        // Direct invocation outside an agent run while the policy asks for
        // approval: there is no framework gate and no way to ask, so refuse.
        // Running would be unprompted execution — the exact thing 'ask'
        // exists to prevent. INSIDE an agent run this branch is unreachable
        // under 'ask': the permission gate's `requireApproval` clone makes
        // Mastra collect the approval BEFORE execute() runs (1.56+ Gate A).
        return {
          kind: 'settled',
          result: {
            detail:
              'No suspension channel is available, so the required run approval could not be requested.',
            kind: 'unavailable',
            reason: 'approval_confirmation_unavailable',
          },
        };
      }
      break;
    }
    case 'network': {
      if (resume.action !== 'allow') {
        return {
          kind: 'settled',
          result: { deniedDomains: requestedDomains, kind: 'network_denied' },
        };
      }
      networkGranted = requestedDomains.length > 0;
      break;
    }
    default: {
      // Unrecognized resume data: fail SAFE and fail VISIBLE — never run,
      // and never attribute the outcome to a user decision the user did not
      // make. `declined` means the user clicked Decline and `network_denied`
      // means they clicked Don't allow; a drifted shape is neither, so
      // labelling it as either would tell an approving user they refused.
      // The typed refusal keeps both gates unanswered: asking again yields a
      // fresh prompt.
      return {
        kind: 'settled',
        result: {
          detail:
            'The resume data did not match either gate decision shape, so the answer could not be read.',
          kind: 'unavailable',
          reason: 'resume_unrecognized',
        },
      };
    }
  }

  if (requestedDomains.length > 0 && !networkGranted) {
    if (!agentContext?.suspend) {
      // Direct invocation outside an agent run. askUser degrades to a
      // readable answer here; run_python MUST NOT — degrading would run the
      // script with network and no prompt, the exact bypass Gate B exists to
      // prevent (and running it offline instead would be a wrong result
      // dressed as a stronger sandbox).
      return {
        kind: 'settled',
        result: {
          detail: 'No suspension channel is available, so network access could not be confirmed.',
          kind: 'unavailable',
          reason: 'network_confirmation_unavailable',
        },
      };
    }
    await agentContext.suspend({
      allowedDomains: requestedDomains,
      kind: 'network',
    } satisfies RunPythonNetworkSuspendPayload);
    return { kind: 'suspended' };
  }

  return { kind: 'run', networkGranted };
}

export interface RunPythonToolOptions {
  /**
   * The Gate A permission decision for THIS call (BST-1097). Since the
   * @mastra/core 1.56 approval rework, Gate A itself is armed by the
   * permission gate's per-tool `requireApproval` clone (the framework's
   * pre-execution approval — see permission-tool-gate.ts); inside an agent
   * run this injected decision no longer raises anything. It is REQUIRED
   * regardless because it closes the DIRECT-invocation hole: a call outside
   * an agent run (no suspension channel, no framework gate) under 'ask' must
   * refuse rather than run unprompted. Composition roots derive it from the
   * request's trusted permission snapshot via `resolveSelfApprovalDecision`
   * (permission-tool-gate.ts) so the tool and the gate cannot disagree.
   */
  readonly resolveApprovalDecision: () => 'allow' | 'ask';
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
 * **Network is expressible ONLY through Gate B (BST-1070).** A call may
 * request `allowedDomains`, but the request alone opens nothing: the policy
 * stays `[]` unless the per-call suspension-channel escalation resumes with
 * an explicit allow — a channel with NO grant surface, so no session grant,
 * per-tool override, or `yolo` posture ever pre-answers it. The prerequisite
 * that kept this inexpressible (suspensions were not rediscovered across a
 * renderer reload) closed in BST-1084.
 *
 * Registered as the factory-returned Mastra Tool object (never re-wrapped in
 * the desktop registry's `{description, execute, id, inputSchema}` literal) —
 * the literal shape silently drops `suspendSchema`, and without it Gate B
 * never fires: the script would run with a non-empty `allowedDomains` and no
 * prompt at all.
 */
export function createRunPythonTool(options: RunPythonToolOptions) {
  return createTool({
    description: TOOL_DESCRIPTIONS[RUN_PYTHON_TOOL_ID],
    execute: async (input, context): Promise<RunPythonResult | undefined> => {
      const parsed = parseRunPythonInput(input);
      // Deduplicated at the SOURCE so the suspend payload, the escalation
      // card's checkbox list (keyed by domain), and ExecPolicy.allowedDomains
      // all agree — a repeated host is harmless intent, not a reason to fail.
      const requestedDomains = [...new Set(parsed.allowedDomains ?? [])];

      // ── The serial two-gate pass (Gate A approval + Gate B network); see
      // passRunPythonGates for the full contract. Every pause fires before
      // the host is resolved.
      const agentContext = (context as { agent?: RunPythonAgentContext } | undefined)?.agent;
      const gateOutcome = await passRunPythonGates({
        agentContext,
        requestedDomains,
        resolveApprovalDecision: options.resolveApprovalDecision,
        // An agent run's resume (Mastra's Tool.execute moves it under
        // `agent`); a call with no agent context reads the context's own
        // `resumeData`, which is how the agent host answers a network consent.
        resumeData: agentContext ? agentContext.resumeData : context?.resumeData,
      });
      if (gateOutcome.kind === 'suspended') {
        return;
      }
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
    outputSchema: RunPythonOutputSchema,
    resumeSchema: RunPythonResumeSchema,
    suspendSchema: RunPythonSuspendSchema,
  });
}
