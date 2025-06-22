/**
 * Shared Playwright environment detection and configuration utilities
 * Used by both desktop and web Playwright configurations
 */

export interface EnvironmentConfig {
  isCodex: boolean;
  isGitHubActions: boolean;
  isCI: boolean;
  workers: number;
  globalTimeout: number;
  retries: number;
  headless: boolean;
  fullyParallel: boolean;
}

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

  if (isCodex) return 1; // Codex has very limited resources
  if (isGitHubActions) return 2; // GitHub Actions free runners have 2 cores
  if (isCI) return 1; // Other CI environments, be conservative
  return 2; // Local development default
};

/**
 * Get global timeout based on environment constraints
 * @param environmentType - Optional override for specific environment type
 */
export const getGlobalTimeout = (env?: ReturnType<typeof detectEnvironment>) => {
  const { isCodex, isCI } = env || detectEnvironment();

  // 10 minutes for Codex (under 15-minute hard limit with buffer)
  if (isCodex) return 10 * 60 * 1000;
  // 15 minutes for other CI environments
  if (isCI) return 15 * 60 * 1000;
  // No global timeout for local development
  return 0;
};

/**
 * Get retry strategy based on environment
 */
export const getRetryCount = (env?: ReturnType<typeof detectEnvironment>) => {
  const { isCodex, isCI } = env || detectEnvironment();

  if (!isCI) return 0; // No retries for local development (fail fast)
  return isCodex ? 1 : 2; // Fewer retries for Codex to save time
};

/**
 * Get browser launch arguments for CI environments
 */
export const getCILaunchArgs = (env?: ReturnType<typeof detectEnvironment>): string[] => {
  const { isCodex, isCI } = env || detectEnvironment();

  if (!isCI) return [];

  const baseArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage', // /dev/shm is tiny in CI
    '--disable-setuid-sandbox',
    '--disable-gpu',
  ];

  // Add extra flags for Codex environment only if absolutely necessary
  // Note: --disable-web-security bypasses same-origin policy - use with caution
  if (isCodex) {
    baseArgs.push('--disable-web-security');
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
    fullyParallel: !env.isCodex, // Codex should avoid parallel execution
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
  console.info(`${appName} Playwright config:`);
  console.info(`  Codex: ${config.isCodex}`);
  console.info(`  GitHub Actions: ${config.isGitHubActions}`);
  console.info(`  General CI: ${config.isCI}`);
  console.info(`  Workers: ${config.workers}`);
  console.info(`  Global timeout: ${config.globalTimeout / 1000}s`);
  console.info(`  Retries: ${config.retries}`);
  console.info(`  Headless: ${config.headless}`);
  if (baseURL) {
    console.info(`  Base URL: ${baseURL}`);
  }
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
    console.warn(`⚠️  ${warning}`);
  }

  return warnings;
};
