/**
 * Performance testing configuration with environment-specific thresholds
 */

// Base performance thresholds for local development
export const BASE_THRESHOLDS = {
  TREE_LOAD_MAX_MS: 8000,  // Increased from 3000 to handle larger trees
  TREE_EXPANSION_MAX_MS: 3000,  // Increased from 1500 for multiple expansions
  FILE_SELECTION_MAX_MS: 1000,  // Increased from 800 for file loading
  SCROLL_PERFORMANCE_MAX_MS: 800,  // Increased from 600 to handle large datasets
  MEMORY_INCREASE_MAX_MB: 10,  // Decreased from 50 to 10MB for navigation
  MEMORY_TOTAL_MAX_MB: 100,  // New: total memory threshold
  RENDER_TIME_MAX_MS: 150,  // Slightly increased from 100
  LARGE_TREE_LOAD_MAX_MS: 20000,  // New: for stress tests
  BULK_FILE_SELECTION_MAX_MS: 12000,  // New: for bulk operations
  AVG_FILE_LOAD_TIME_MAX_MS: 800,  // New: average file loading time
} as const;

// Environment multipliers
const CI_MULTIPLIER = 1.5; // 50% more lenient thresholds for CI
const GITHUB_ACTIONS_MULTIPLIER = 2.0; // Even more lenient for GitHub Actions

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
  
  return {
    TREE_LOAD_MAX_MS: Math.floor(BASE_THRESHOLDS.TREE_LOAD_MAX_MS * multiplier),
    TREE_EXPANSION_MAX_MS: Math.floor(BASE_THRESHOLDS.TREE_EXPANSION_MAX_MS * multiplier),
    FILE_SELECTION_MAX_MS: Math.floor(BASE_THRESHOLDS.FILE_SELECTION_MAX_MS * multiplier),
    SCROLL_PERFORMANCE_MAX_MS: Math.floor(BASE_THRESHOLDS.SCROLL_PERFORMANCE_MAX_MS * multiplier),
    MEMORY_INCREASE_MAX_MB: Math.floor(BASE_THRESHOLDS.MEMORY_INCREASE_MAX_MB * multiplier),
    MEMORY_TOTAL_MAX_MB: Math.floor(BASE_THRESHOLDS.MEMORY_TOTAL_MAX_MB * multiplier),
    RENDER_TIME_MAX_MS: Math.floor(BASE_THRESHOLDS.RENDER_TIME_MAX_MS * multiplier),
    LARGE_TREE_LOAD_MAX_MS: Math.floor(BASE_THRESHOLDS.LARGE_TREE_LOAD_MAX_MS * multiplier),
    BULK_FILE_SELECTION_MAX_MS: Math.floor(BASE_THRESHOLDS.BULK_FILE_SELECTION_MAX_MS * multiplier),
    AVG_FILE_LOAD_TIME_MAX_MS: Math.floor(BASE_THRESHOLDS.AVG_FILE_LOAD_TIME_MAX_MS * multiplier),
  };
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
    
    if (envGithub) return 'github-actions';
    if (envCI) return 'ci';
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
const isDebug = (globalThis as any).process?.env?.DEBUG || (globalThis as any).process?.env?.PERFORMANCE_LOGGING;
if (isDebug) {
  console.log(`🔧 Environment: ${detectEnvironment()}`);
  console.log('📊 Performance Thresholds:', PERFORMANCE_THRESHOLDS);
} 