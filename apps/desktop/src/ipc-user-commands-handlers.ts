/**
 * User-defined slash command discovery IPC handler (desktop / main-process).
 *
 * Resolves the mounted workspace roots from the DB `roots` table (the same seam
 * `getWorkspaceRoots`/`loadWorkspaceRootsFromDatabase` uses, so each id is the DB
 * `roots.id` that `@file` directives resolve against — never a raw path), scans
 * the four command-file tiers, and returns the deduped list plus the roots it
 * scanned (so the renderer can bind `@path` tokens for global commands).
 *
 * A DB failure does NOT abort discovery: global (`~`) commands need no roots, so
 * we log the failure and continue with an empty root set — global commands stay
 * available, project commands are simply absent that pass (no silent success —
 * the failure is logged).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/utils/logger';
import {
  MAX_USER_COMMAND_FILE_BYTES,
  scanUserSlashCommands,
  type UserSlashCommandScanDeps,
  type UserSlashCommandScanRoot,
} from './assistant-server/user-slash-commands-loader';
import {
  loadWorkspaceRootsFromDatabase,
  type WorkspaceRootsQueryable,
} from './assistant-server/workspace-roots';

const logger = createLogger('UserSlashCommands');
const warnedSymlinkCommandDirectories = new Set<string>();

export const __resetUserCommandsHandlerWarningsForTests = () =>
  warnedSymlinkCommandDirectories.clear();

export interface UserCommandsListDeps {
  /** Injected fs surface (real disk in production, in-memory in tests). */
  readonly fs: UserSlashCommandScanDeps;
  /** Resolve the queryable DB, or null when it is unavailable. */
  readonly getDatabase: () => Promise<WorkspaceRootsQueryable | null>;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
}

/** Real-disk fs deps: a directory read yields entries; a missing path yields null. */
export function createNodeFsScanDeps(): UserSlashCommandScanDeps {
  const validatedDirectories = new Set<string>();
  return {
    listDir: (absDir, containmentRoot) => {
      try {
        const canonicalRoot = realpathSync(containmentRoot);
        const canonicalDirectory = realpathSync(absDir);
        const relative = path.relative(canonicalRoot, canonicalDirectory);
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          if (!warnedSymlinkCommandDirectories.has(absDir)) {
            warnedSymlinkCommandDirectories.add(absDir);
            logger.warn('Skipping symlinked slash command directory');
          }
          return null;
        }
        validatedDirectories.add(canonicalDirectory);
        return readdirSync(canonicalDirectory, { withFileTypes: true }).map((entry) => ({
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          name: entry.name,
        }));
      } catch {
        return null;
      }
    },
    readFile: (absFile) => {
      try {
        const canonicalFile = realpathSync(absFile);
        if (!validatedDirectories.has(path.dirname(canonicalFile))) {
          return { ok: false, reason: 'unreadable' };
        }
        // Bound the read BEFORE pulling untrusted bytes into the main process:
        // a giant file would block main and (unbounded) balloon renderer memory
        // over IPC. The bound is a BYTE ceiling (MAX_USER_COMMAND_FILE_BYTES =
        // 4× the char cap), so a multi-byte file under the character cap is
        // never falsely rejected; a file above it is DEFINITIVELY oversized and
        // reported as such (honest reason — the loader logs a warn, not a
        // spurious "Failed to read"), never a blocking multi-hundred-MB read.
        if (statSync(canonicalFile).size > MAX_USER_COMMAND_FILE_BYTES) {
          return { ok: false, reason: 'oversized' };
        }
        return { content: readFileSync(canonicalFile, 'utf8'), ok: true };
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
    },
  };
}

async function resolveScanRoots(
  getDatabase: () => Promise<WorkspaceRootsQueryable | null>
): Promise<UserSlashCommandScanRoot[]> {
  let database: WorkspaceRootsQueryable | null;
  try {
    database = await getDatabase();
  } catch (error) {
    logger.error('Workspace roots DB unavailable; only global slash commands will load.', {
      error,
    });
    return [];
  }
  if (!database) {
    return [];
  }
  try {
    const roots = await loadWorkspaceRootsFromDatabase(database);
    // A root whose DB `path` is null (unresolved) has no usable scan directory:
    // `absPath: ''` would join to `/.brainstrike/commands` — an absolute path
    // off the real filesystem root — and bind any commands found there to that
    // root. Filter such roots out so an unresolved root is neither scanned nor
    // reported (never a filesystem-root scan).
    return roots
      .filter((root): root is typeof root & { path: string } => Boolean(root.path))
      .map((root) => ({
        absPath: root.path,
        displayName: root.displayName ?? '',
        id: root.rootId,
      }));
  } catch (error) {
    logger.error('Failed to load workspace roots; only global slash commands will load.', {
      error,
    });
    return [];
  }
}

export async function listUserSlashCommands(
  deps: UserCommandsListDeps
): Promise<UserSlashCommandsListResult> {
  const roots = await resolveScanRoots(deps.getDatabase);
  const commands = scanUserSlashCommands({ homeDir: deps.homedir(), roots }, deps.fs);
  return {
    commands,
    roots: roots.map((root) => ({ displayName: root.displayName, id: root.id })),
  };
}

/**
 * Production entry point: wires the real DB host, home dir, and disk fs. The DB
 * loader is imported lazily so this module stays cheap to import at preload/main
 * registration time.
 */
export function createUserCommandsListHandler(): () => Promise<UserSlashCommandsListResult> {
  return () =>
    listUserSlashCommands({
      fs: createNodeFsScanDeps(),
      getDatabase: async () => {
        const { getDatabase } = await import('./db-main');
        return getDatabase();
      },
      homedir,
    });
}
