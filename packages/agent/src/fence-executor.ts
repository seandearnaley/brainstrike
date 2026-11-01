/**
 * Node-only entrypoint for the OS-fence code-execution backend (BST-1062).
 *
 * Kept off the root / browser-safe entrypoints on purpose: it pulls in
 * `@anthropic-ai/sandbox-runtime`, which spawns platform sandbox tooling and
 * proxy servers. Same precedent as `@brainstrike/agent/mcp-client`.
 */

export {
  createFenceExecutor,
  createFenceExecutorFactory,
  FenceExecutorDisposedError,
  type FenceExecutorOptions,
  type FenceInterpreter,
  type FenceInterpreterMap,
  FenceInvalidRequestError,
  FenceProcessGroupTeardownError,
  FenceQueueTimeoutError,
  FenceUnsupportedLanguageError,
  FenceUnsupportedPlatformError,
  INHERITED_ENV_VARS,
} from './fence/fence-executor.ts';
export {
  ALWAYS_DENY_READ_PATHS,
  buildSandboxRuntimeConfig,
  type FencePathResolver,
  FencePolicyError,
  isFencePolicyError,
} from './fence/fence-policy.ts';
export {
  FenceReadinessError,
  type FenceReadinessReason,
  isFenceReadinessError,
} from './fence/fence-readiness-error.ts';
export {
  createFencedShell,
  type FencedShell,
  type FencedShellCommand,
  type FencedShellRequest,
} from './fence/fence-shell.ts';
export { isFenceSupported } from './fence/fence-support.ts';
