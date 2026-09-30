/**
 * Code-execution backend seam (BST-1060).
 *
 * Every agent code-execution ticket plugs into this interface: mode one wraps
 * a bundled CPython in an @anthropic-ai/sandbox-runtime OS fence; mode two is
 * an opt-in VM workspace. The seam sits between tool dispatch and the actual
 * process spawn — approval/permission gating happens ABOVE it in the existing
 * permission engine (docs/agents/assistant-runtime.md), and backends are
 * selected purely by host capability (does the factory exist?), never by
 * platform sniffing.
 *
 * Everything a backend may disagree about is decided HERE, once: input
 * validation, policy shape, capability reconciliation, and kind↔tier
 * correctness. A backend that re-derives any of these can drift from its
 * sibling backend, which is the silent-degradation class this seam exists to
 * prevent.
 */
import {
  MAX_EXEC_CODE_LENGTH,
  MAX_EXEC_TIMEOUT_MS,
  MAX_POLICY_DOMAIN_LENGTH,
  MAX_POLICY_ENTRIES,
  policyDomainSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { z } from 'zod';

// The policy domain grammar and its limits live on the browser-safe side of the
// Mastra boundary (BST-1646) because the run_python INPUT schema needs them;
// this seam re-exports them so its public API is unchanged.
export {
  MAX_EXEC_CODE_LENGTH,
  MAX_EXEC_TIMEOUT_MS,
  MAX_POLICY_DOMAIN_LENGTH,
  MAX_POLICY_ENTRIES,
  policyDomainSchema,
};

export const EXEC_LANGUAGES = ['python', 'javascript', 'bash'] as const;

export type ExecLanguage = (typeof EXEC_LANGUAGES)[number];

export const EXECUTOR_KINDS = ['fence', 'vm'] as const;

export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

const EXECUTOR_KIND_SET: ReadonlySet<string> = new Set(EXECUTOR_KINDS);

/**
 * Renders a rejected value for an error message without ever throwing.
 * `JSON.stringify` throws on BigInt and on circular objects, which would
 * replace this boundary's contracted error with an opaque TypeError.
 */
function describeRejectedValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'function') {
    return 'function value';
  }
  if (typeof value === 'object' && value !== null) {
    return 'object value';
  }
  try {
    return String(value);
  } catch {
    return `${typeof value} value`;
  }
}

export function parseExecutorKind(value: unknown): ExecutorKind {
  if (typeof value === 'string' && EXECUTOR_KIND_SET.has(value)) {
    return value as ExecutorKind;
  }
  throw new Error(
    `${describeRejectedValue(value)} is not a supported code-execution mode; expected one of ${EXECUTOR_KINDS.join(', ')}.`
  );
}

export const MAX_POLICY_PATH_LENGTH = 4096;
export const MAX_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024;

const POSIX_ABSOLUTE_PATH = /^\//;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/;

/**
 * Splits on the separators the path's own platform actually uses. A backslash
 * is a separator ONLY in a Windows-shaped path: on POSIX it is a legal
 * filename character, so splitting on it unconditionally would read
 * `/tmp/scratch\run` — a sibling directory literally named `scratch\run` — as
 * a descendant of `/tmp/scratch`.
 */
function pathSegments(value: string): string[] {
  const separator = isWindowsShapedPath(value) ? /[\\/]+/ : /\/+/;
  return value.split(separator).filter((segment) => segment.length > 0);
}

function isWindowsShapedPath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(value) || WINDOWS_UNC_PATH.test(value);
}

function isAbsolutePath(value: string): boolean {
  return POSIX_ABSOLUTE_PATH.test(value) || isWindowsShapedPath(value);
}

/**
 * Leading segments naming the VOLUME rather than a directory, across both
 * operands. `C:\dir` contributes 1 (the drive letter); `\\server\share\dir`
 * contributes 2 (host and share — SMB treats both case-insensitively). A
 * POSIX path contributes 0, so nothing folds.
 */
function windowsVolumeSegmentCount(target: string, root: string): number {
  const count = (value: string): number => {
    if (WINDOWS_UNC_PATH.test(value)) {
      return 2;
    }
    return WINDOWS_ABSOLUTE_PATH.test(value) ? 1 : 0;
  };
  return Math.max(count(target), count(root));
}

/**
 * Absolute, traversal-free, length-bounded paths only. A leading `~` is
 * REJECTED rather than expanded: sandbox-runtime resolves paths against its
 * own process context, so a `denyRead: ['~/.ssh']` that reaches it unexpanded
 * is a deny rule that silently protects nothing. Backends build home-relative
 * deny lists from their own resolved home directory.
 */
const policyPathSchema = z
  .string()
  .min(1)
  .max(MAX_POLICY_PATH_LENGTH)
  .refine((value) => value.trim().length > 0, { message: 'must not be blank' })
  .refine(isAbsolutePath, {
    message: 'must be an absolute path (a leading "~" is not expanded here)',
  })
  .refine((value) => !pathSegments(value).includes('..'), {
    message: 'must not contain a ".." segment',
  });

const policyPathListSchema = z.array(policyPathSchema).max(MAX_POLICY_ENTRIES);

/**
 * Maps 1:1 onto sandbox-runtime's SandboxRuntimeConfig: allowWrite/allowRead/
 * denyRead → filesystem.*, allowedDomains → network.allowedDomains. An empty
 * allowedDomains list means NO network — srt's proxy denies every connection
 * that matches no allowed domain.
 */
export const execPolicySchema = z
  .object({
    allowedDomains: z.array(policyDomainSchema).max(MAX_POLICY_ENTRIES),
    allowRead: policyPathListSchema.optional(),
    allowWrite: policyPathListSchema,
    denyRead: policyPathListSchema.optional(),
  })
  .strict();

export type ExecPolicy = z.infer<typeof execPolicySchema>;

/**
 * True when `target` is one of `roots` or lies beneath one of them.
 *
 * Conservative by construction: an unresolved `..` segment in EITHER operand
 * returns false rather than a prefix match. A pure segment-prefix compare
 * would report `/tmp/scratch/../../etc/passwd` as covered by `/tmp/scratch`,
 * and this predicate is exported for backends to use on runtime-computed
 * paths (a resolved temp dir, a path read back from the sandbox) that never
 * passed through `policyPathSchema`. It never claims coverage it cannot
 * prove; resolve paths before asking.
 *
 * Comparison is case-sensitive everywhere EXCEPT the Windows drive letter
 * (BST-1074). Drive-letter case is what Node APIs spell inconsistently, so
 * folding it prevents an error the caller cannot act on. Directory segments
 * are NOT folded: NTFS supports per-directory case sensitivity (WSL enables
 * it), so folding them could report coverage the filesystem does not grant —
 * a false PERMIT, which is the unsafe direction, and the same platform-shaped
 * guess this module rejects for darwin. A case-insensitive volume is served
 * correctly by resolving first: `realpath` returns the canonical on-disk
 * spelling.
 */
export function isPathCoveredBy(target: string, roots: readonly string[]): boolean {
  const targetSegments = pathSegments(target);
  if (targetSegments.includes('..')) {
    return false;
  }
  return roots.some((root) => {
    const rootSegments = pathSegments(root);
    if (rootSegments.includes('..') || rootSegments.length > targetSegments.length) {
      return false;
    }
    // How many leading segments name the VOLUME rather than a directory:
    // `C:\dir` → 1 (the drive), `\\server\share\dir` → 2 (host + share, both
    // case-insensitive at the SMB protocol level). Everything after that is a
    // directory, which never folds.
    const volumeSegments = windowsVolumeSegmentCount(target, root);
    return rootSegments.every((segment, index) => {
      const targetSegment = targetSegments[index] ?? '';
      return index < volumeSegments
        ? segment.toLowerCase() === targetSegment.toLowerCase()
        : segment === targetSegment;
    });
  });
}

/**
 * The WHOLE request is validated here, not just the policy half: a backend
 * left to interpret `timeoutMs: NaN` or a `scratchDir` the sandbox cannot
 * write would have to invent a convention, and clamping is exactly the quiet
 * degradation this seam forbids.
 *
 * `signal` is required so user Stop always reaches the process: the desktop
 * runtime aborts its execution controller on cancel, and a backend that never
 * receives that signal keeps a spawned process alive until `timeoutMs`.
 * `maxOutputBytes` is required so the capture bound is a property of the
 * request rather than a per-backend accident.
 */
export const execInputSchema = z
  .object({
    code: z.string().max(MAX_EXEC_CODE_LENGTH),
    language: z.enum(EXEC_LANGUAGES),
    maxOutputBytes: z.number().int().positive().max(MAX_EXEC_OUTPUT_BYTES),
    policy: execPolicySchema,
    scratchDir: policyPathSchema,
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal, {
      message: 'must be an AbortSignal',
    }),
    timeoutMs: z.number().int().positive().max(MAX_EXEC_TIMEOUT_MS),
  })
  .strict()
  .refine((input) => isPathCoveredBy(input.scratchDir, input.policy.allowWrite), {
    message: 'scratchDir must be covered by policy.allowWrite',
    path: ['scratchDir'],
  });

export type ExecInput = z.infer<typeof execInputSchema>;

/**
 * `exitCode` is null exactly when the process was terminated by a signal —
 * including a timeout kill — and `signal` names it. Omitted byte counts
 * replace a single `truncated` flag: one boolean for two streams cannot say
 * which stream was cut or how much was dropped.
 */
export interface ExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stderrOmittedBytes: number;
  readonly stdout: string;
  readonly stdoutOmittedBytes: number;
  readonly timedOut: boolean;
}

export function isExecResultTruncated(result: ExecResult): boolean {
  return result.stdoutOmittedBytes > 0 || result.stderrOmittedBytes > 0;
}

export type ExecIsolationTier = 'none' | 'os-fence' | 'vm';

export type ExecPlatform = 'darwin' | 'linux' | 'win32';

export interface ExecutorCapabilities {
  readonly languages: readonly ExecLanguage[];
  readonly maxIsolationTier: ExecIsolationTier;
  readonly platform: ExecPlatform;
  readonly supportsNetwork: boolean;
}

export interface CodeExecutor {
  capabilities(): ExecutorCapabilities;
  dispose(): Promise<void>;
  execute(input: ExecInput): Promise<ExecResult>;
}

export type CodeExecutorFactory = (signal?: AbortSignal) => CodeExecutor | Promise<CodeExecutor>;

/**
 * A host advertises a backend by providing its factory — absence means the
 * capability does not exist on this host.
 */
export interface CodeExecutorHostCapabilities {
  readonly fence?: CodeExecutorFactory;
  readonly vm?: CodeExecutorFactory;
}

export class ExecutorKindUnavailableError extends Error {
  readonly code = 'executor_kind_unavailable' as const;
  readonly requestedKind: ExecutorKind;
  readonly availableKinds: readonly ExecutorKind[];

  constructor(requestedKind: ExecutorKind, availableKinds: readonly ExecutorKind[]) {
    const available = availableKinds.length > 0 ? availableKinds.join(', ') : 'none';
    super(
      `This workspace requests '${requestedKind}' code execution, but the host does not support it (available: ${available}).`
    );
    this.name = 'ExecutorKindUnavailableError';
    this.requestedKind = requestedKind;
    this.availableKinds = availableKinds;
  }
}

export function isExecutorKindUnavailableError(
  value: unknown
): value is ExecutorKindUnavailableError {
  return value instanceof ExecutorKindUnavailableError;
}

/** The isolation tier a backend registered under each kind MUST report. */
export const REQUIRED_ISOLATION_TIER: Readonly<Record<ExecutorKind, ExecIsolationTier>> = {
  fence: 'os-fence',
  vm: 'vm',
};

export class ExecutorTierMismatchError extends Error {
  readonly code = 'executor_tier_mismatch' as const;
  readonly requestedKind: ExecutorKind;
  readonly requiredTier: ExecIsolationTier;
  readonly reportedTier: ExecIsolationTier;

  constructor(
    requestedKind: ExecutorKind,
    requiredTier: ExecIsolationTier,
    reportedTier: ExecIsolationTier
  ) {
    super(
      `The executor registered for '${requestedKind}' reports isolation tier '${reportedTier}', but '${requestedKind}' requires '${requiredTier}'.`
    );
    this.name = 'ExecutorTierMismatchError';
    this.requestedKind = requestedKind;
    this.requiredTier = requiredTier;
    this.reportedTier = reportedTier;
  }
}

export function isExecutorTierMismatchError(value: unknown): value is ExecutorTierMismatchError {
  return value instanceof ExecutorTierMismatchError;
}

/**
 * Picks the backend for the workspace's requested mode. A mode the host
 * cannot satisfy throws — there is deliberately no vm→fence downgrade (or any
 * other): silently weakening the isolation a workspace asked for is exactly
 * the fallback the two-mode design forbids.
 *
 * Factory PRESENCE is not sufficient evidence of isolation, so the resolved
 * executor's advertised tier is checked against the kind. A backend that
 * cannot apply its platform sandbox must reject construction rather than
 * return a weaker executor under the same kind. Construction is awaited so
 * asynchronous readiness checks finish before any executor is exposed.
 *
 * The caller owns the returned executor's lifetime: each resolve invokes the
 * factory, so each resolve yields a NEW executor that must be `dispose()`d.
 */
export async function resolveCodeExecutor(
  requested: ExecutorKind,
  host: CodeExecutorHostCapabilities,
  signal?: AbortSignal
): Promise<CodeExecutor> {
  const factory = host[requested];
  if (!factory) {
    throw new ExecutorKindUnavailableError(
      requested,
      EXECUTOR_KINDS.filter((kind) => host[kind] !== undefined)
    );
  }
  const executor = await factory(signal);
  const requiredTier = REQUIRED_ISOLATION_TIER[requested];
  const reportedTier = executor.capabilities().maxIsolationTier;
  if (reportedTier !== requiredTier) {
    // The caller never receives this executor, so it cannot own the lifetime
    // the contract assigns it. Release it here — the mismatch case is exactly
    // the misconfigured backend, which may already hold a process, socket, or
    // VM handle. A failing dispose must not mask the tier diagnostic.
    void executor.dispose().catch(() => undefined);
    throw new ExecutorTierMismatchError(requested, requiredTier, reportedTier);
  }
  return executor;
}

/**
 * The run was cancelled via `ExecInput.signal`.
 *
 * Thrown for BOTH positions — aborted while queued behind another execution,
 * and aborted mid-run — because `ExecResult` describes a run that COMPLETED,
 * normally or by timeout. Encoding an abort as a result would make it
 * distinguishable from a timeout only by the ABSENCE of a flag
 * (`exitCode: null, timedOut: false`), forcing every consumer to
 * reverse-engineer the intent. Backends throw this instead, so callers write
 * one `catch`.
 *
 * Whatever the process managed to produce before it was killed rides on the
 * error rather than being discarded — a debug bundle can still show it —
 * without pretending the run finished. `processStarted` distinguishes "nothing
 * ever spawned" from "killed mid-run", which is the difference between no side
 * effects and possible partial ones.
 */
export class ExecAbortedError extends Error {
  readonly code = 'exec_aborted' as const;
  override readonly cause: unknown;
  readonly partialStderr: string;
  readonly partialStdout: string;
  readonly processStarted: boolean;
  readonly stderrOmittedBytes: number;
  readonly stdoutOmittedBytes: number;

  constructor(options: {
    readonly cause?: unknown;
    readonly partialStderr?: string;
    readonly partialStdout?: string;
    readonly processStarted: boolean;
    readonly stderrOmittedBytes?: number;
    readonly stdoutOmittedBytes?: number;
  }) {
    const message = options.processStarted
      ? options.cause === undefined
        ? 'The execution was aborted and its process tree was terminated; any output it had already produced is on this error.'
        : 'The execution was aborted, but process-tree termination could not be confirmed; any output it had already produced and the teardown failure are on this error.'
      : 'The execution was aborted before any process started, so no code ran.';
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExecAbortedError';
    this.cause = options.cause;
    this.partialStderr = options.partialStderr ?? '';
    this.partialStdout = options.partialStdout ?? '';
    this.processStarted = options.processStarted;
    this.stderrOmittedBytes = options.stderrOmittedBytes ?? 0;
    this.stdoutOmittedBytes = options.stdoutOmittedBytes ?? 0;
  }
}

export function isExecAbortedError(value: unknown): value is ExecAbortedError {
  return value instanceof ExecAbortedError;
}

export type ExecCapabilityMismatchReason = 'language_unsupported' | 'network_unsupported';

export class ExecCapabilityMismatchError extends Error {
  readonly code = 'exec_capability_mismatch' as const;
  readonly reason: ExecCapabilityMismatchReason;

  constructor(reason: ExecCapabilityMismatchReason, message: string) {
    super(message);
    this.name = 'ExecCapabilityMismatchError';
    this.reason = reason;
  }
}

export function isExecCapabilityMismatchError(
  value: unknown
): value is ExecCapabilityMismatchError {
  return value instanceof ExecCapabilityMismatchError;
}

/**
 * Backends MUST call this before executing. A request that exceeds what the
 * executor advertises is a visible typed error — never a quieter run. Running
 * a network-requesting script with networking silently off is a STRONGER
 * sandbox but a WRONG result: the script completes with exit code 0 and
 * missing data.
 */
export function assertExecRequestSatisfiable(
  capabilities: ExecutorCapabilities,
  input: ExecInput
): void {
  if (!capabilities.languages.includes(input.language)) {
    const supported =
      capabilities.languages.length > 0 ? capabilities.languages.join(', ') : 'none';
    throw new ExecCapabilityMismatchError(
      'language_unsupported',
      `This executor cannot run ${input.language} (supported: ${supported}).`
    );
  }
  if (input.policy.allowedDomains.length > 0 && !capabilities.supportsNetwork) {
    throw new ExecCapabilityMismatchError(
      'network_unsupported',
      'This request allows network domains, but the executor has no network support. Run it with an empty allowedDomains list, or use an executor that supports networking.'
    );
  }
}

export class NoSandboxConfiguredError extends Error {
  readonly code = 'no_sandbox_configured' as const;

  constructor() {
    super(
      'No code-execution sandbox is configured on this host, so the code was not run. Code execution becomes available once a sandbox backend is installed.'
    );
    this.name = 'NoSandboxConfiguredError';
  }
}

export function isNoSandboxConfiguredError(value: unknown): value is NoSandboxConfiguredError {
  return value instanceof NoSandboxConfiguredError;
}

/**
 * Integration stub: lets tool code build against the seam before any backend
 * lands. It never spawns anything — every execute() rejects with the typed
 * no-sandbox error (the tool layer maps it to a model-visible structured
 * failure), so wiring it is not an isolation downgrade.
 *
 * It reports `maxIsolationTier: 'none'` and therefore CANNOT be registered as
 * a host's `fence`/`vm` factory: `resolveCodeExecutor` rejects it with
 * `ExecutorTierMismatchError`. Tool code integrates with it directly.
 */
export function createNullCodeExecutor(options: { readonly platform: ExecPlatform }): CodeExecutor {
  return {
    capabilities: () => ({
      languages: [],
      maxIsolationTier: 'none',
      platform: options.platform,
      supportsNetwork: false,
    }),
    dispose: () => Promise.resolve(),
    execute: () => Promise.reject(new NoSandboxConfiguredError()),
  };
}
