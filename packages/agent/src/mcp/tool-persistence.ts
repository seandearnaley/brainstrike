import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';

const logger = createLogger('ToolPersistence');

export interface ToolPreferences {
  enabledTools: string[];
  disabledTools: string[];
  version: number;
  lastUpdated: number;
}

/**
 * Load tool preferences from disk
 */
export async function loadToolPreferences(
  userDataDir: string
): Promise<ToolPreferences | undefined> {
  const prefsPath = getToolPreferencesPath(userDataDir);

  try {
    const content = await fsp.readFile(prefsPath, 'utf-8');
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
      enabledCount: parsed.enabledTools.length,
      disabledCount: parsed.disabledTools.length,
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
    return;
  }
}

/**
 * Save tool preferences to disk
 */
export async function saveToolPreferences(
  userDataDir: string,
  preferences: ToolPreferences
): Promise<void> {
  const prefsPath = getToolPreferencesPath(userDataDir);
  const prefsDir = path.dirname(prefsPath);

  try {
    await fsp.mkdir(prefsDir, { recursive: true });

    const content = JSON.stringify(
      {
        ...preferences,
        lastUpdated: Date.now(),
      },
      null,
      2
    );

    await fsp.writeFile(prefsPath, content, 'utf-8');

    logger.info('tool preferences saved', {
      code: 'preferences_saved',
      enabledCount: preferences.enabledTools.length,
      disabledCount: preferences.disabledTools.length,
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
export async function deleteToolPreferences(userDataDir: string): Promise<void> {
  const prefsPath = getToolPreferencesPath(userDataDir);

  try {
    await fsp.unlink(prefsPath);
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
function getToolPreferencesPath(userDataDir: string): string {
  return path.join(userDataDir, 'mcp', 'tool-preferences.json');
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
    enabledTools: [],
    disabledTools: [],
    version: 1,
    lastUpdated: Date.now(),
  };
}
