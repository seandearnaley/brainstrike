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
 */
import { z } from 'zod';

export type ExecLanguage = 'python' | 'javascript' | 'bash';

export type ExecutorKind = 'fence' | 'vm';

const EXECUTOR_KINDS: readonly ExecutorKind[] = ['fence', 'vm'];

export function parseExecutorKind(value: unknown): ExecutorKind {
  if (value === 'fence' || value === 'vm') {
    return value;
  }
  throw new Error(
    `${JSON.stringify(value)} is not a supported code-execution mode; expected one of ${EXECUTOR_KINDS.join(', ')}.`
  );
}

const boundedNonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must not be blank',
  });

/**
 * Maps 1:1 onto sandbox-runtime's SandboxRuntimeConfig: allowWrite/allowRead/
 * denyRead → filesystem.*, allowedDomains → network.allowedDomains. An empty
 * allowedDomains list means NO network — srt's proxy denies every connection
 * that matches no allowed domain.
 */
export const execPolicySchema = z
  .object({
    allowedDomains: z.array(boundedNonBlankString),
    allowRead: z.array(boundedNonBlankString).optional(),
    allowWrite: z.array(boundedNonBlankString),
    denyRead: z.array(boundedNonBlankString).optional(),
  })
  .strict();

export type ExecPolicy = z.infer<typeof execPolicySchema>;

export interface ExecInput {
  readonly code: string;
  readonly language: ExecLanguage;
  readonly policy: ExecPolicy;
  readonly scratchDir: string;
  readonly timeoutMs: number;
}

/**
 * stdout/stderr are already bounded by the executor; the tool layer's model
 * projection must still fit them into the existing tool output budgets
 * (docs/agents/assistant-providers.md).
 */
export interface ExecResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
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

export type CodeExecutorFactory = () => CodeExecutor;

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

/**
 * Picks the backend for the workspace's requested mode. A mode the host
 * cannot satisfy throws — there is deliberately no vm→fence downgrade (or any
 * other): silently weakening the isolation a workspace asked for is exactly
 * the fallback the two-mode design forbids.
 */
export function resolveCodeExecutor(
  requested: ExecutorKind,
  host: CodeExecutorHostCapabilities
): CodeExecutor {
  const factory = requested === 'fence' ? host.fence : host.vm;
  if (!factory) {
    throw new ExecutorKindUnavailableError(
      requested,
      EXECUTOR_KINDS.filter((kind) =>
        kind === 'fence' ? host.fence !== undefined : host.vm !== undefined
      )
    );
  }
  return factory();
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
