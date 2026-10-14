import { randomBytes } from 'node:crypto';
import { ToolInputError } from '@brainstrike/assistant-contract';

const HANDLE_PREFIX = 'rfh_';
const HANDLE_RANDOM_BYTES = 16;
const HANDLE_PATTERN = /^rfh_[A-Za-z0-9_-]{22}$/;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;
const MAX_HANDLE_GENERATION_ATTEMPTS = 3;

export const READ_WORKSPACE_FILE_CURSOR_HANDLE_LENGTH =
  HANDLE_PREFIX.length + Math.ceil((HANDLE_RANDOM_BYTES * 4) / 3);

export interface ReadWorkspaceFileCursorScope {
  readonly resourceId: string;
  readonly threadId: string;
}

export interface ReadWorkspaceFileCursorState {
  readonly column: number;
  readonly endLine: number;
  readonly line: number;
  readonly mtimeMs: number;
  readonly path: string;
  readonly requestedEndLine: number | null;
  readonly requestedStartLine: number | null;
  readonly rootId: string;
  readonly size: number;
}

interface ReadWorkspaceFileCursorEntry {
  readonly expiresAt: number;
  readonly scope: ReadWorkspaceFileCursorScope;
  readonly state: ReadWorkspaceFileCursorState;
}

export interface ReadWorkspaceFileCursorRegistryOptions {
  readonly createHandle?: () => string;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

function defaultCreateHandle(): string {
  return `${HANDLE_PREFIX}${randomBytes(HANDLE_RANDOM_BYTES).toString('base64url')}`;
}

function scopesMatch(
  left: ReadWorkspaceFileCursorScope,
  right: ReadWorkspaceFileCursorScope
): boolean {
  return left.resourceId === right.resourceId && left.threadId === right.threadId;
}

export class ReadWorkspaceFileCursorRegistry {
  readonly #createHandle: () => string;
  readonly #entries = new Map<string, ReadWorkspaceFileCursorEntry>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: ReadWorkspaceFileCursorRegistryOptions = {}) {
    this.#createHandle = options.createHandle ?? defaultCreateHandle;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new Error('readWorkspaceFile cursor registry maxEntries must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error('readWorkspaceFile cursor registry ttlMs must be a positive integer.');
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Drop every handle a deleted thread issued. */
  forgetThread(threadId: string): void {
    for (const [handle, entry] of this.#entries) {
      if (entry.scope.threadId === threadId) {
        this.#entries.delete(handle);
      }
    }
  }

  issue(scope: ReadWorkspaceFileCursorScope, state: ReadWorkspaceFileCursorState): string {
    const now = this.#now();
    this.#deleteExpired(now);
    // Handles are reusable until they expire; when full, evict the oldest issue.
    for (const handle of this.#entries.keys()) {
      if (this.#entries.size < this.#maxEntries) {
        break;
      }
      this.#entries.delete(handle);
    }

    for (let attempt = 0; attempt < MAX_HANDLE_GENERATION_ATTEMPTS; attempt += 1) {
      const handle = this.#createHandle();
      if (!HANDLE_PATTERN.test(handle)) {
        throw new Error(
          'The readWorkspaceFile continuation handle generator returned an invalid handle.'
        );
      }
      if (this.#entries.has(handle)) {
        continue;
      }
      this.#entries.set(handle, {
        expiresAt: now + this.#ttlMs,
        scope: { ...scope },
        state: { ...state },
      });
      return handle;
    }

    throw new Error('The readWorkspaceFile continuation handle generator produced collisions.');
  }

  resolve(handle: string, scope: ReadWorkspaceFileCursorScope): ReadWorkspaceFileCursorState {
    return { ...this.#getEntry(handle, scope).state };
  }

  #getEntry(handle: string, scope: ReadWorkspaceFileCursorScope): ReadWorkspaceFileCursorEntry {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new ToolInputError(
        'The readWorkspaceFile continuation handle is malformed. Start a new read without cursor.'
      );
    }
    const entry = this.#entries.get(handle);
    if (!entry) {
      throw new ToolInputError(
        'The readWorkspaceFile continuation handle is unknown or no longer available. Start a new read without cursor.'
      );
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(handle);
      throw new ToolInputError(
        'The readWorkspaceFile continuation handle has expired. Start a new read without cursor.'
      );
    }
    if (!scopesMatch(entry.scope, scope)) {
      throw new ToolInputError(
        'The readWorkspaceFile continuation handle belongs to another assistant thread. Start a new read without cursor.'
      );
    }
    return entry;
  }

  #deleteExpired(now: number): void {
    for (const [handle, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(handle);
      }
    }
  }
}

export const readWorkspaceFileCursorRegistry = new ReadWorkspaceFileCursorRegistry();

export function clearReadWorkspaceFileCursorRegistry(): Promise<void> {
  readWorkspaceFileCursorRegistry.clear();
  return Promise.resolve();
}
