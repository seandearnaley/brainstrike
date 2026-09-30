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
  isFenceSupported,
} from './fence/fence-executor';
export {
  ALWAYS_DENY_READ_PATHS,
  buildSandboxRuntimeConfig,
  type FencePathResolver,
  FencePolicyError,
  isFencePolicyError,
} from './fence/fence-policy';

export {
  FenceReadinessError,
  type FenceReadinessReason,
  isFenceReadinessError,
} from './fence/fence-readiness-error';
