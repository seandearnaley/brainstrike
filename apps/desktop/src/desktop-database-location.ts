import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import { app } from 'electron';
import {
  type DatabaseLocation,
  type GitProfileContext,
  joinProfileDirectory,
  PACKAGED_PRODUCT_DIR_NAME,
  resolveDatabaseLocation,
} from './database-location';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV } from './db-runtime-env';

const logger = createLogger('DesktopDatabaseLocation');

/**
 * Main-process ownership of the desktop database location. Main resolves it
 * ONCE, and both `db-main` (in main) and `db-host-manager` (which hands it to
 * the utility-process DB host through the environment) read this same cached
 * value, so main's reset path and the host's open database can never disagree
 * about which profile they mean. The utility process never calls this.
 */
let cachedLocation: DatabaseLocation | null = null;

export function isIsolatedDesktopTestRun(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.argv.includes('--test-mode');
}

function parseGitHeadToBranch(headContent: string): string | null {
  const trimmed = headContent.trim();
  if (!trimmed.length) {
    return null;
  }

  if (trimmed.startsWith('ref:')) {
    const ref = trimmed.slice(4).trim();
    if (ref.startsWith('refs/heads/')) {
      return ref.slice('refs/heads/'.length);
    }
    return ref;
  }

  return `detached-${trimmed.slice(0, 12)}`;
}

function tryReadGitBranchFromGitDir(gitDirPath: string): string | null {
  const headPath = path.join(gitDirPath, 'HEAD');
  if (!existsSync(headPath)) {
    return null;
  }
  return parseGitHeadToBranch(readFileSync(headPath, 'utf8'));
}

function tryResolveGitDirFromPointer(currentDir: string, gitPointerPath: string): string | null {
  const gitPointer = readFileSync(gitPointerPath, 'utf8').trim();
  const gitDirMatch = /^gitdir:\s*(.+)$/i.exec(gitPointer);
  if (!gitDirMatch?.[1]) {
    return null;
  }
  return path.resolve(currentDir, gitDirMatch[1].trim());
}

function tryReadGitContextAtDirectory(currentDir: string): GitProfileContext | null {
  const gitPath = path.join(currentDir, '.git');
  if (!existsSync(gitPath)) {
    return null;
  }

  try {
    const stats = lstatSync(gitPath);

    if (stats.isDirectory()) {
      return {
        branch: tryReadGitBranchFromGitDir(gitPath),
        workspaceSeed: path.resolve(currentDir),
      };
    }

    if (stats.isFile()) {
      const resolvedGitDir = tryResolveGitDirFromPointer(currentDir, gitPath);
      if (resolvedGitDir) {
        return {
          branch: tryReadGitBranchFromGitDir(resolvedGitDir),
          workspaceSeed: path.resolve(currentDir),
        };
      }
    }
  } catch {
    // Unreadable git metadata means "no branch": the development profile falls back to dev-default.
  }

  return null;
}

function resolveGitContextFromDirectory(startDir: string): GitProfileContext | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const contextAtCurrentDir = tryReadGitContextAtDirectory(currentDir);
    if (contextAtCurrentDir) {
      return contextAtCurrentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function resetDesktopDatabaseLocationForTests(): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('resetDesktopDatabaseLocationForTests can only be used in test mode');
  }
  cachedLocation = null;
}

/** Main's profile directory: the directory the DB host it forks opens, from the same location. */
export function resolveDesktopDatabaseProfileDirectory(): string {
  const location = resolveDesktopDatabaseLocation();
  return joinProfileDirectory(location.rootPath, location.profile);
}

export function resolveDesktopDatabaseLocation(): DatabaseLocation {
  if (cachedLocation) {
    return cachedLocation;
  }
  if (!app || typeof app.getPath !== 'function') {
    throw new Error(
      'Desktop database location is unavailable: Electron app path resolution is unavailable in this process. Only the main process resolves it; the DB host receives it through its environment.'
    );
  }

  const location = resolveDatabaseLocation({
    env: {
      localAppData: process.env['LOCALAPPDATA'],
      profileOverride: process.env[DB_PROFILE_ENV],
      rootOverride: process.env[DB_ROOT_PATH_ENV],
      xdgDataHome: process.env['XDG_DATA_HOME'],
    },
    isPackaged: app.isPackaged,
    isTestRun: isIsolatedDesktopTestRun(),
    // Lazy on purpose: a packaged or test run must not ask Electron for `documents`
    // (nor `home` off Linux), and a getter that throws must not fail a run that
    // never reads it. Pinned per rule in desktop-database-location.test.ts.
    paths: {
      get documents() {
        return app.getPath('documents');
      },
      get home() {
        return app.getPath('home');
      },
      get userData() {
        return app.getPath('userData');
      },
    },
    platform: process.platform,
    productDirName: PACKAGED_PRODUCT_DIR_NAME,
    readGitContext: () => resolveGitContextFromDirectory(process.cwd()),
  });
  cachedLocation = location;
  logger.info('Desktop database location resolved', {
    profile: location.profile,
    rootPath: location.rootPath,
    source: location.source,
  });
  return location;
}
