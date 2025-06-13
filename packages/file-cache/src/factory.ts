import { detectPlatform } from '@brainstrike/platform-utils';
import { FileCacheService } from './cache-service';
import type { FileCacheAdapter, FileCacheConfig } from './types';

/**
 * Create a file cache adapter based on the current platform
 */
export function createFileCache(config?: Partial<FileCacheConfig>): FileCacheAdapter {
  const platform = detectPlatform();

  // Default configuration based on platform
  const defaultConfig: FileCacheConfig = {
    dataDir: getDefaultDataDir(platform),
    pgOptions: {
      relaxedDurability: platform === 'web', // Enable for web to avoid blocking IndexedDB writes
      debug: false,
    },
    tableName: 'cached_files',
  };

  // Merge with user-provided config
  const finalConfig: FileCacheConfig = {
    ...defaultConfig,
    ...config,
    pgOptions: {
      ...defaultConfig.pgOptions,
      ...config?.pgOptions,
    },
  };

  return new FileCacheService(finalConfig);
}

/**
 * Create a file cache adapter for testing (uses in-memory storage)
 */
export function createTestFileCache(config?: Partial<FileCacheConfig>): FileCacheAdapter {
  const testConfig: FileCacheConfig = {
    dataDir: 'memory://',
    pgOptions: {
      relaxedDurability: false,
      debug: false,
    },
    tableName: 'test_cached_files',
    ...config,
  };

  return new FileCacheService(testConfig);
}

/**
 * Get the default data directory based on platform
 */
function getDefaultDataDir(platform: string): string {
  switch (platform) {
    case 'web':
      return 'idb://brainstrike-file-cache';

    case 'electron':
      return getElectronDataDir();

    default:
      // Fallback for other Node.js environments
      return './brainstrike-cache';
  }
}

/**
 * Get the Electron data directory path
 */
function getElectronDataDir(): string {
  try {
    // Dynamic import to avoid issues in non-Electron environments
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app: { getPath: (name: string) => string } };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as { join: (...paths: string[]) => string };

    // Use Electron's userData directory
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'pglite-cache');
  } catch (_error) {
    // Fallback if Electron is not available
    console.warn('Electron not available, using fallback cache directory');
    return './brainstrike-cache';
  }
}

/**
 * Create a file cache adapter with a custom data directory
 */
export function createFileCacheWithDataDir(
  dataDir: string,
  config?: Partial<Omit<FileCacheConfig, 'dataDir'>>
): FileCacheAdapter {
  const finalConfig: FileCacheConfig = {
    dataDir,
    pgOptions: {
      relaxedDurability: dataDir.startsWith('idb://'),
      debug: false,
    },
    tableName: 'cached_files',
    ...config,
  };

  return new FileCacheService(finalConfig);
}
