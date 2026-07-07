import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('ToolPersistence');

export interface FileSystemAdapter {
  dirname: (filePath: string) => string;
  join: (...segments: string[]) => string;
  mkdir: (dirPath: string, options: { recursive: boolean }) => Promise<unknown>;
  readFile: (filePath: string, encoding: 'utf-8') => Promise<string>;
  unlink: (filePath: string) => Promise<void>;
  writeFile: (filePath: string, content: string, encoding: 'utf-8') => Promise<void>;
}

const defaultFs: FileSystemAdapter = {
  dirname: (filePath) => path.dirname(filePath),
  join: (...segments) => path.join(...segments),
  mkdir: (dirPath, options) => fsp.mkdir(dirPath, options),
  readFile: (filePath, encoding) => fsp.readFile(filePath, encoding),
  unlink: (filePath) => fsp.unlink(filePath),
  writeFile: (filePath, content, encoding) => fsp.writeFile(filePath, content, encoding),
};

export interface ToolPreferences {
  disabledTools: string[];
  enabledTools: string[];
  lastUpdated: number;
  version: number;
}

/**
 * Load tool preferences from disk
 */
export async function loadToolPreferences(
  userDataDir: string,
  fs: FileSystemAdapter = defaultFs
): Promise<ToolPreferences | undefined> {
  const prefsPath = getToolPreferencesPath(userDataDir, fs);

  try {
    const content = await fs.readFile(prefsPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (!isValidToolPreferences(parsed)) {
      logger.warn('invalid tool preferences file', {
        code: 'invalid_preferences',
        path: prefsPath,
      });
      return;
    }

    logger.info('tool preferences loaded', {
      code: 'preferences_loaded',
      disabledCount: parsed.disabledTools.length,
      enabledCount: parsed.enabledTools.length,
    });

    return parsed;
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ENOENT') {
      logger.info('no tool preferences found', { code: 'no_preferences' });
      return;
    }

    logger.error('failed to load tool preferences', {
      code: 'load_preferences_failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return;
}

/**
 * Save tool preferences to disk
 */
export async function saveToolPreferences(
  userDataDir: string,
  preferences: ToolPreferences,
  fs: FileSystemAdapter = defaultFs
): Promise<void> {
  const prefsPath = getToolPreferencesPath(userDataDir, fs);
  const prefsDir = fs.dirname(prefsPath);

  try {
    await fs.mkdir(prefsDir, { recursive: true });

    const content = JSON.stringify(
      {
        ...preferences,
        lastUpdated: Date.now(),
      },
      null,
      2
    );

    await fs.writeFile(prefsPath, content, 'utf-8');

    logger.info('tool preferences saved', {
      code: 'preferences_saved',
      disabledCount: preferences.disabledTools.length,
      enabledCount: preferences.enabledTools.length,
    });
  } catch (error) {
    logger.error('failed to save tool preferences', {
      code: 'save_preferences_failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Delete tool preferences file
 */
export async function deleteToolPreferences(
  userDataDir: string,
  fs: FileSystemAdapter = defaultFs
): Promise<void> {
  const prefsPath = getToolPreferencesPath(userDataDir, fs);

  try {
    await fs.unlink(prefsPath);
    logger.info('tool preferences deleted', { code: 'preferences_deleted' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return; // File doesn't exist, nothing to delete
    }
    throw error;
  }
}

/**
 * Get the path to tool preferences file
 */
function getToolPreferencesPath(userDataDir: string, fs: FileSystemAdapter = defaultFs): string {
  return fs.join(userDataDir, 'mcp', 'tool-preferences.json');
}

/**
 * Type guard for tool preferences
 */
function isValidToolPreferences(value: unknown): value is ToolPreferences {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const obj = value as Record<string, unknown>;

  return (
    Array.isArray(obj['enabledTools']) &&
    obj['enabledTools'].every((item) => typeof item === 'string') &&
    Array.isArray(obj['disabledTools']) &&
    obj['disabledTools'].every((item) => typeof item === 'string') &&
    typeof obj['version'] === 'number' &&
    typeof obj['lastUpdated'] === 'number'
  );
}

/**
 * Create default tool preferences
 */
export function createDefaultToolPreferences(): ToolPreferences {
  return {
    disabledTools: [],
    enabledTools: [],
    lastUpdated: Date.now(),
    version: 1,
  };
}
