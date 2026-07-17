import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@brainstrike/utils';
import type { StorageAdapter } from '../types.js';

const logger = createLogger('ElectronStorageAdapter');

/** JSON formatting indentation for storage files */
const JSON_INDENT_SPACES = 2;

/**
 * Error thrown when a path traversal attempt is detected
 */
export class PathTraversalError extends Error {
  constructor(attemptedPath: string, basePath: string) {
    super(`Path traversal detected: "${attemptedPath}" escapes base directory "${basePath}"`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Error thrown when Electron provides a path that cannot safely persist storage.
 */
export class InvalidUserDataPathError extends Error {
  constructor(userDataPath: string) {
    super(`Invalid Electron userData path: "${userDataPath}"`);
    this.name = 'InvalidUserDataPathError';
  }
}

/**
 * Error thrown when existing durable storage cannot be loaded safely.
 */
export class StorageFileLoadError extends Error {
  constructor(storePath: string, cause: unknown) {
    super(`Failed to load Electron storage file: "${storePath}"`, { cause });
    this.name = 'StorageFileLoadError';
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

/**
 * Validates that a resolved path stays within the specified base directory.
 * Prevents path traversal attacks (e.g., "../../../etc/passwd").
 *
 * @param resolvedPath - The fully resolved path to validate
 * @param basePath - The base directory that resolvedPath must stay within
 * @throws PathTraversalError if the path escapes the base directory
 */
function validatePathContainment(resolvedPath: string, basePath: string): void {
  const normalizedBase = path.normalize(basePath);
  const normalizedPath = path.normalize(resolvedPath);

  // Ensure the resolved path starts with the base path
  // Add trailing separator to prevent prefix attacks (e.g., /userData vs /userDataAttack)
  const baseWithSep = normalizedBase.endsWith(path.sep)
    ? normalizedBase
    : `${normalizedBase}${path.sep}`;

  if (!normalizedPath.startsWith(baseWithSep) && normalizedPath !== normalizedBase) {
    throw new PathTraversalError(resolvedPath, basePath);
  }
}

/**
 * Electron Storage Adapter
 *
 * File-based storage implementation for Electron applications.
 *
 * Security features:
 * - Atomic writes: Uses temp file + rename to prevent corruption on crash
 * - Path containment: Validates paths stay within userData directory
 * - Failure visibility: Rejects operations when durable storage is unavailable or corrupt
 */
export class ElectronStorageAdapter implements StorageAdapter {
  private storePath = '';
  private cache: Record<string, string> = {};
  private ready: Promise<void>;
  /** Mutation lock keeps each staged write and in-memory commit in invocation order. */
  private persistLock: Promise<void> = Promise.resolve();

  constructor(storeFile = 'electron-storage.json') {
    this.ready = this.initialize(storeFile).catch((error) => {
      if (!(error instanceof PathTraversalError)) {
        logger.error('Electron storage initialization failed', {
          error: error instanceof Error ? error.message : String(error),
          storeFile,
        });
      }

      throw error;
    });

    // Avoid a global unhandled-rejection event if initialization finishes before the
    // first operation. The original ready promise stays rejected for every caller.
    void this.ready.catch(() => undefined);
  }

  /**
   * Initializes the storage adapter by loading Electron and setting up the store file.
   */
  private async initialize(storeFile: string): Promise<void> {
    const { app } = await import('electron');
    await app.whenReady();

    const userDataPath = app.getPath('userData');
    if (!this.isValidUserDataPath(userDataPath)) {
      throw new InvalidUserDataPathError(userDataPath);
    }

    const fullPath = this.validateAndResolvePath(storeFile, userDataPath);
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    this.storePath = fullPath;

    await this.loadExistingCache();
  }

  /**
   * Checks if the userData path is valid for persistence.
   */
  private isValidUserDataPath(userDataPath: string): boolean {
    return Boolean(userDataPath && path.isAbsolute(userDataPath)) && userDataPath !== process.cwd();
  }

  /**
   * Validates path containment and returns the full resolved path.
   * @throws PathTraversalError if the path escapes userData directory
   */
  private validateAndResolvePath(storeFile: string, userDataPath: string): string {
    const fullPath = path.resolve(userDataPath, storeFile);

    try {
      validatePathContainment(fullPath, userDataPath);
    } catch (error) {
      if (error instanceof PathTraversalError) {
        logger.error('Path traversal attempt rejected', {
          resolvedPath: fullPath,
          storeFile,
          userDataPath,
        });
      }
      throw error;
    }

    return fullPath;
  }

  /**
   * Loads the existing cache from disk if the file exists.
   */
  private async loadExistingCache(): Promise<void> {
    try {
      const data = await fsPromises.readFile(this.storePath, 'utf8');
      const parsed: unknown = JSON.parse(data);
      if (!isStringRecord(parsed)) {
        throw new TypeError('Electron storage file must contain an object with string values');
      }
      this.cache = parsed;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return;
      }

      throw new StorageFileLoadError(this.storePath, error);
    }
  }

  /**
   * Serializes a staged mutation, persists it, then commits it to memory.
   * Failed writes never change the committed cache seen by later operations.
   */
  private mutate(
    mutation: (stagedCache: Record<string, string>) => void,
    allowLoadErrorRecovery = false
  ): Promise<void> {
    const operation = this.persistLock.then(async () => {
      let recoveringFromLoadError = false;
      try {
        await this.ready;
      } catch (error) {
        const canRecover =
          allowLoadErrorRecovery &&
          Boolean(this.storePath) &&
          error instanceof StorageFileLoadError;
        if (!canRecover) {
          throw error;
        }
        recoveringFromLoadError = true;
      }

      const stagedCache = { ...this.cache };
      mutation(stagedCache);
      await this.doPersist(stagedCache);
      this.cache = stagedCache;

      if (recoveringFromLoadError) {
        this.ready = Promise.resolve();
      }
    });

    // Keep the serialization tail usable after failure while returning the original
    // operation so the caller still observes its mutation error.
    this.persistLock = operation.catch((error) => {
      logger.error('Electron storage mutation failed', {
        error: error instanceof Error ? error.message : String(error),
        storePath: this.storePath,
      });
    });

    return operation;
  }

  /**
   * Internal persist implementation - writes cache to disk atomically.
   */
  private async doPersist(cache: Record<string, string>): Promise<void> {
    // Generate a unique temp file name in the same directory
    // Using the same directory ensures rename is atomic (same filesystem)
    const tempFileName = `.${path.basename(this.storePath)}.${crypto.randomUUID()}.tmp`;
    const tempPath = path.join(path.dirname(this.storePath), tempFileName);

    try {
      // Write to temp file first
      const jsonContent = JSON.stringify(cache, null, JSON_INDENT_SPACES);
      await fsPromises.writeFile(tempPath, jsonContent, 'utf8');

      // Atomic rename - this is atomic on POSIX systems and most Windows configurations
      await fsPromises.rename(tempPath, this.storePath);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await fsPromises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async getItem(key: string): Promise<string | null> {
    await this.ready;
    return this.cache[key] ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    return this.mutate((stagedCache) => {
      stagedCache[key] = value;
    });
  }

  async removeItem(key: string): Promise<void> {
    return this.mutate((stagedCache) => {
      delete stagedCache[key];
    });
  }

  async clear(): Promise<void> {
    return this.mutate((stagedCache) => {
      for (const key of Object.keys(stagedCache)) {
        delete stagedCache[key];
      }
    }, true);
  }

  async getAllKeys(): Promise<string[]> {
    await this.ready;
    return Object.keys(this.cache);
  }
}
