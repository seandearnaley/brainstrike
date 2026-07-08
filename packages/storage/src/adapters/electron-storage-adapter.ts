import crypto from 'node:crypto';
import fs from 'node:fs';
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
 * - Warning logs: Alerts when persistence is disabled
 */
export class ElectronStorageAdapter implements StorageAdapter {
  private storePath = '';
  private cache: Record<string, string> = {};
  private readonly ready: Promise<void>;
  /** Write lock to serialize persist operations and prevent race conditions */
  private persistLock: Promise<void> = Promise.resolve();

  constructor(storeFile = 'electron-storage.json') {
    this.ready = this.initialize(storeFile).catch((error) => {
      // Rethrow security-critical errors - these should not be silently swallowed
      if (error instanceof PathTraversalError) {
        throw error;
      }

      logger.warn('Electron import failed, using in-memory storage only', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.cache = {};
    });
  }

  /**
   * Initializes the storage adapter by loading Electron and setting up the store file.
   */
  private async initialize(storeFile: string): Promise<void> {
    const { app } = await import('electron');
    await app.whenReady();

    const userDataPath = app.getPath('userData');
    if (!this.isValidUserDataPath(userDataPath)) {
      logger.warn('Persistence disabled: userData path is invalid or equals cwd', {
        cwd: process.cwd(),
        userDataPath,
      });
      this.cache = {};
      return;
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
    if (!fs.existsSync(this.storePath)) {
      return;
    }

    try {
      const data = await fsPromises.readFile(this.storePath, 'utf8');
      this.cache = JSON.parse(data) as Record<string, string>;
    } catch (parseError) {
      logger.warn('Storage file corrupted or unreadable, starting with empty cache', {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        storePath: this.storePath,
      });
      this.cache = {};
    }
  }

  /**
   * Persists the cache to disk using atomic write (temp file + rename).
   * This prevents data corruption if the process crashes mid-write.
   * Uses a write lock to serialize operations and prevent race conditions.
   */
  private async persist(): Promise<void> {
    // Chain persist operations to prevent race conditions
    this.persistLock = this.persistLock.then(() => this.doPersist());
    return this.persistLock;
  }

  /**
   * Internal persist implementation - writes cache to disk atomically.
   */
  private async doPersist(): Promise<void> {
    await this.ready;

    // Don't persist if storePath wasn't set (e.g., electron import failed)
    if (!this.storePath) {
      return;
    }

    // Generate a unique temp file name in the same directory
    // Using the same directory ensures rename is atomic (same filesystem)
    const tempFileName = `.${path.basename(this.storePath)}.${crypto.randomUUID()}.tmp`;
    const tempPath = path.join(path.dirname(this.storePath), tempFileName);

    try {
      // Write to temp file first
      const jsonContent = JSON.stringify(this.cache, null, JSON_INDENT_SPACES);
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
    await this.ready;
    this.cache[key] = value;
    await this.persist();
  }

  async removeItem(key: string): Promise<void> {
    await this.ready;
    delete this.cache[key];
    await this.persist();
  }

  async clear(): Promise<void> {
    await this.ready;
    this.cache = {};
    await this.persist();
  }

  async getAllKeys(): Promise<string[]> {
    await this.ready;
    return Object.keys(this.cache);
  }
}
