/**
 * Shared Playwright environment detection and configuration utilities
 * Used by both desktop and web Playwright configurations
 */

export interface EnvironmentConfig {
  fullyParallel: boolean;
  globalTimeout: number;
  headless: boolean;
  isCI: boolean;
  isCodex: boolean;
  isGitHubActions: boolean;
  retries: number;
  workers: number;
}

/**
 * Node warns when both FORCE_COLOR and NO_COLOR are set.
 * Playwright child processes inherit our environment, so normalize it once up front.
 */
export const harmonizeColorEnvironment = (): void => {
  if (process.env['FORCE_COLOR'] && process.env['NO_COLOR']) {
    Reflect.deleteProperty(process.env, 'NO_COLOR');
  }
};

/**
 * Detect the current environment based on environment variables
 */
export const detectEnvironment = () => {
  const codexEnv = 'CODEX_ENV';
  const githubActionsEnv = 'GITHUB_ACTIONS';
  const ciEnv = 'CI';

  const isCodex = !!process.env[codexEnv];
  const isGitHubActions = !!process.env[githubActionsEnv];
  const isCI = !!process.env[ciEnv] || isCodex || isGitHubActions;

  return { isCodex, isGitHubActions, isCI };
};

/**
 * Get worker count based on environment capabilities
 */
export const getWorkerCount = (env?: ReturnType<typeof detectEnvironment>) => {
  const { isCodex, isGitHubActions, isCI } = env || detectEnvironment();

  if (isCodex) {
    return 1; // Codex has very limited resources
  }
  if (isGitHubActions) {
    return 2; // GitHub Actions private-repo runners have 2 vCPU (public repos get 4)
  }
  if (isCI) {
    return 1; // Other CI environments, be conservative
  }
  return 2; // Local development default
};

/**
 * Keep Playwright's suite-level global timeout disabled. CI jobs already have
 * explicit step timeouts, and a hidden Playwright global timer can kill a
 * sharded desktop suite mid-file after many passing tests.
 */
export const getGlobalTimeout = (env?: ReturnType<typeof detectEnvironment>) => {
  void (env || detectEnvironment());
  return 0;
};

/**
 * Get retry strategy based on environment
 */
export const getRetryCount = (env?: ReturnType<typeof detectEnvironment>) => {
  const { isCodex, isCI } = env || detectEnvironment();

  if (!isCI) {
    return 0; // No retries for local development (fail fast)
  }
  return isCodex ? 1 : 2; // Fewer retries for Codex to save time
};

/**
 * Get browser launch arguments for CI environments
 */
export const getCILaunchArgs = (env?: ReturnType<typeof detectEnvironment>): string[] => {
  const { isCodex, isCI } = env || detectEnvironment();

  if (!isCI) {
    return [];
  }

  const baseArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage', // /dev/shm is tiny in CI
    '--disable-setuid-sandbox',
    // '--disable-gpu', // Removed to test if this causes instability in CI
    '--disable-features=VizDisplayCompositor', // Helps with headless environments
  ];

  // Add extra flags for Codex environment only if absolutely necessary
  // Note: --disable-web-security bypasses same-origin policy - use with caution
  if (isCodex) {
    baseArgs.push(
      '--disable-web-security',
      '--disable-extensions',
      '--disable-plugins',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    );
  }

  return baseArgs;
};

/**
 * Get complete environment configuration
 */
export const getEnvironmentConfig = (): EnvironmentConfig => {
  const env = detectEnvironment();

  return {
    ...env,
    workers: getWorkerCount(env),
    globalTimeout: getGlobalTimeout(env),
    retries: getRetryCount(env),
    // Always use headless mode for reliability in all environments
    // This prevents X server/display issues in containerized CI environments
    // Local development can override with --headed flag if needed
    headless: true,
    // Keep multiple workers in CI, but do not run tests from the same file concurrently.
    // Stateful browser specs share expensive origin-level surfaces like OPFS and app boot.
    fullyParallel: !env.isCI,
  };
};

/**
 * Log environment configuration for debugging
 */
export const logEnvironmentConfig = (
  appName: string,
  config: EnvironmentConfig,
  baseURL?: string
) => {
  const details = [
    `isCodex=${String(config.isCodex)}`,
    `isGitHubActions=${String(config.isGitHubActions)}`,
    `isCI=${String(config.isCI)}`,
    `workers=${String(config.workers)}`,
    `globalTimeout=${String(config.globalTimeout)}`,
    `retries=${String(config.retries)}`,
    `headless=${String(config.headless)}`,
    `fullyParallel=${String(config.fullyParallel)}`,
  ];
  const basePart = baseURL ? ` baseURL=${baseURL}` : '';
  process.stdout.write(`[playwright:${appName}] ${details.join(' ')}${basePart}\n`);
};

/**
 * Validate environment configuration
 */
export const validateEnvironmentConfig = (config: EnvironmentConfig) => {
  const warnings: string[] = [];

  // Check for missing browser path in Codex
  const browsersPathEnv = 'PLAYWRIGHT_BROWSERS_PATH';
  if (config.isCodex && !process.env[browsersPathEnv]) {
    warnings.push('PLAYWRIGHT_BROWSERS_PATH not set for Codex environment');
  }

  // Warn about web security being disabled
  if (config.isCodex) {
    warnings.push('Web security disabled for Codex environment - use only in trusted CI');
  }

  // Log warnings
  for (const warning of warnings) {
    process.stderr.write(`[playwright:warning] ${warning}\n`);
  }

  return warnings;
};
