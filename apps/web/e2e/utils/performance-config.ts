/**
 * Performance testing configuration with environment-specific thresholds
 */

// Base performance thresholds for local development
export const BASE_THRESHOLDS = {
  AVG_FILE_LOAD_TIME_MAX_MS: 800, // New: average file loading time
  BULK_FILE_SELECTION_MAX_MS: 12_000, // New: for bulk operations
  FILE_SELECTION_MAX_MS: 1000, // Increased from 800 for file loading
  LARGE_TREE_LOAD_MAX_MS: 20_000, // New: for stress tests
  MEMORY_INCREASE_MAX_MB: 10, // Decreased from 50 to 10MB for navigation
  MEMORY_TOTAL_MAX_MB: 100, // Baseline total memory threshold (no heavy local DB)
  RENDER_TIME_MAX_MS: 150, // Slightly increased from 100
  SCROLL_PERFORMANCE_MAX_MS: 800, // Increased from 600 to handle large datasets
  STRESS_MEMORY_INCREASE_MAX_MB: 20, // Stress tests: default 20MB cap
  TREE_EXPANSION_MAX_MS: 3000, // Increased from 1500 for multiple expansions
  TREE_LOAD_MAX_MS: 8000, // Increased from 3000 to handle larger trees
} as const;

// Environment multipliers
const CI_MULTIPLIER = 1.5; // 50% more lenient thresholds for CI
const GITHUB_ACTIONS_MULTIPLIER = 2.0; // Even more lenient for GitHub Actions

// Additional CI-specific minimums based on observed GitHub Actions variance in 2025
// Keep these tight and targeted, only for known noisy metrics.
const GITHUB_ACTIONS_MINIMUMS = {
  FILE_SELECTION_MAX_MS: 2300, // was 2000 after multiplier; rare flake ~2150ms
  RENDER_TIME_MAX_MS: 420, // was 300 after multiplier; CI observed ~335–402ms
  SCROLL_PERFORMANCE_MAX_MS: 2000, // was 1600 after multiplier; CI observed ~1650–1900ms
} as const;

function isLocalFirstDbEnabled(): boolean {
  try {
    const env = (globalThis as any).process?.env ?? {};
    const flags = [
      env['LOCAL_FIRST_DB'],
      env['EMBED_QUEUE_ENABLED'],
      env['LOCAL_DB_MODE'],
      env['PGLITE_EXPECTED'],
    ];
    return flags.some((v: unknown) => String(v ?? '').toLowerCase() === 'true');
  } catch {
    return false;
  }
}

/**
 * Get performance thresholds adjusted for the specified environment
 */
export function getEnvironmentThresholds(environment: 'local' | 'ci' | 'github-actions' = 'local') {
  let multiplier = 1.0;

  switch (environment) {
    case 'github-actions':
      multiplier = GITHUB_ACTIONS_MULTIPLIER;
      break;
    case 'ci':
      multiplier = CI_MULTIPLIER;
      break;
    default:
      multiplier = 1.0;
  }

  // Start with base thresholds adjusted for environment
  let thresholds = {
    AVG_FILE_LOAD_TIME_MAX_MS: Math.floor(BASE_THRESHOLDS.AVG_FILE_LOAD_TIME_MAX_MS * multiplier),
    BULK_FILE_SELECTION_MAX_MS: Math.floor(BASE_THRESHOLDS.BULK_FILE_SELECTION_MAX_MS * multiplier),
    FILE_SELECTION_MAX_MS: Math.floor(BASE_THRESHOLDS.FILE_SELECTION_MAX_MS * multiplier),
    LARGE_TREE_LOAD_MAX_MS: Math.floor(BASE_THRESHOLDS.LARGE_TREE_LOAD_MAX_MS * multiplier),
    MEMORY_INCREASE_MAX_MB: Math.floor(BASE_THRESHOLDS.MEMORY_INCREASE_MAX_MB * multiplier),
    MEMORY_TOTAL_MAX_MB: Math.floor(BASE_THRESHOLDS.MEMORY_TOTAL_MAX_MB * multiplier),
    RENDER_TIME_MAX_MS: Math.floor(BASE_THRESHOLDS.RENDER_TIME_MAX_MS * multiplier),
    SCROLL_PERFORMANCE_MAX_MS: Math.floor(BASE_THRESHOLDS.SCROLL_PERFORMANCE_MAX_MS * multiplier),
    STRESS_MEMORY_INCREASE_MAX_MB: Math.floor(
      BASE_THRESHOLDS.STRESS_MEMORY_INCREASE_MAX_MB * multiplier
    ),
    TREE_EXPANSION_MAX_MS: Math.floor(BASE_THRESHOLDS.TREE_EXPANSION_MAX_MS * multiplier),
    TREE_LOAD_MAX_MS: Math.floor(BASE_THRESHOLDS.TREE_LOAD_MAX_MS * multiplier),
  } as const;

  // For GitHub Actions only, apply targeted minimums to mitigate transient VM jitter
  if (environment === 'github-actions') {
    thresholds = {
      ...thresholds,
      FILE_SELECTION_MAX_MS: Math.max(
        thresholds.FILE_SELECTION_MAX_MS,
        GITHUB_ACTIONS_MINIMUMS.FILE_SELECTION_MAX_MS
      ),
      RENDER_TIME_MAX_MS: Math.max(
        thresholds.RENDER_TIME_MAX_MS,
        GITHUB_ACTIONS_MINIMUMS.RENDER_TIME_MAX_MS
      ),
      SCROLL_PERFORMANCE_MAX_MS: Math.max(
        thresholds.SCROLL_PERFORMANCE_MAX_MS,
        GITHUB_ACTIONS_MINIMUMS.SCROLL_PERFORMANCE_MAX_MS
      ),
    } as typeof thresholds;
  }

  // If local-first DB is expected (e.g., PGlite loaded early), allow higher memory
  if (isLocalFirstDbEnabled()) {
    // Allow higher total memory to account for WASM/DB baseline; keep other metrics tight
    const relaxedTotal = Math.max(thresholds.MEMORY_TOTAL_MAX_MB, 350);
    const relaxedIncrease = Math.max(thresholds.MEMORY_INCREASE_MAX_MB, 150); // navigation baseline still small
    const relaxedStressIncrease = Math.max(thresholds.STRESS_MEMORY_INCREASE_MAX_MB, 300); // stress can spike much higher under local-first
    return {
      ...thresholds,
      MEMORY_INCREASE_MAX_MB: relaxedIncrease,
      MEMORY_TOTAL_MAX_MB: relaxedTotal,
      STRESS_MEMORY_INCREASE_MAX_MB: relaxedStressIncrease,
    } as const;
  }

  return thresholds;
}

/**
 * Detect current environment based on environment variables
 * Uses try-catch to safely access process.env
 */
export function detectEnvironment(): 'local' | 'ci' | 'github-actions' {
  try {
    // Safe access to environment variables
    const envCI = (globalThis as any).process?.env?.CI;
    const envGithub = (globalThis as any).process?.env?.GITHUB_ACTIONS;

    if (envGithub) {
      return 'github-actions';
    }
    if (envCI) {
      return 'ci';
    }
  } catch {
    // If process is not available, assume local environment
  }

  return 'local';
}

/**
 * Default performance thresholds for the current environment
 */
export const PERFORMANCE_THRESHOLDS = getEnvironmentThresholds(detectEnvironment());

// Log environment and thresholds for debugging (only in debug mode)
const isDebug =
  (globalThis as any).process?.env?.DEBUG || (globalThis as any).process?.env?.PERFORMANCE_LOGGING;
if (isDebug) {
  console.log(`🔧 Environment: ${detectEnvironment()}`);
  console.log('📊 Performance Thresholds:', PERFORMANCE_THRESHOLDS);
}
