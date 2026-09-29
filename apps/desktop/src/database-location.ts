import { createHash } from 'node:crypto';
import path from 'node:path';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV } from './db-runtime-env';

/**
 * Pure, Electron-free resolution of WHERE the desktop database lives. Main
 * resolves it once (`desktop-database-location.ts`) and hands both fields to
 * the DB host through the environment; the host never derives its own.
 *
 * `NODE_ENV` deliberately plays no part: nothing in the build or packaging
 * sets it, so "packaged" is decided by `app.isPackaged`, never by an
 * environment string.
 */

export interface GitProfileContext {
  readonly branch: string | null;
  readonly workspaceSeed: string;
}

export interface DatabaseLocationInput {
  readonly env: {
    /** `%LOCALAPPDATA%`; required for a packaged Windows build. */
    readonly localAppData?: string | undefined;
    /**
     * Reduced to one safe path segment (`a/b` becomes `a-b`). Throws when it
     * reduces to nothing (`.`, `..`, `-`) or to a Windows device name (`nul`);
     * blank or a literal `undefined` is treated as unset.
     */
    readonly profileOverride?: string | undefined;
    /** Throws unless fully qualified (a Windows root needs a drive or UNC prefix). */
    readonly rootOverride?: string | undefined;
    readonly xdgDataHome?: string | undefined;
  };
  readonly isPackaged: boolean;
  /** `NODE_ENV === 'test'` or `--test-mode`: isolate into userData. */
  readonly isTestRun: boolean;
  /**
   * Read by property, only when the selected rule needs it: the main-side caller
   * passes getters, so never spread or destructure this object.
   */
  readonly paths: { readonly documents: string; readonly home: string; readonly userData: string };
  readonly platform: NodeJS.Platform;
  readonly productDirName: string;
  /** Called only when the development profile has to be derived. */
  readonly readGitContext: () => GitProfileContext | null;
}

/**
 * Which rule produced the location. `override` means the environment supplied
 * BOTH fields; a single overridden field reports the rule that produced the
 * other one.
 */
export type DatabaseLocationSource = 'development' | 'override' | 'packaged' | 'test';

export interface DatabaseLocation {
  readonly profile: string;
  readonly rootPath: string;
  readonly source: DatabaseLocationSource;
}

/** Must equal `build.productName` in `apps/desktop/package.json` (pinned by a test). */
export const PACKAGED_PRODUCT_DIR_NAME = 'BrainStrike Desktop';

const DEVELOPMENT_ROOT_DIR_NAME = 'BrainStrike-dev';
const PACKAGED_DATA_DIR_NAME = 'data';
const PACKAGED_PROFILE = 'default';
const TEST_PROFILE = 'test';
const DEVELOPMENT_FALLBACK_PROFILE = 'dev-default';
const WORKTREE_PROFILE_HASH_LENGTH = 8;
const WORKTREE_PROFILE_BRANCH_MAX = 40;

const PROFILE_SEGMENT_MAX_LENGTH = 64;
const FALLBACK_PROFILE_SEGMENT = 'default';

/**
 * Reduces `raw` to ONE safe path segment, or '' when nothing usable remains:
 * lowercase `[a-z0-9._-]`, path separators turned into `-`, and no leading or
 * trailing dot (so never `.` or `..`; Windows also drops a trailing dot). The
 * segment is joined under `<root>/profiles/` and factory reset deletes that
 * directory recursively, so a `..` here would delete the whole root.
 */
function toProfileSegment(raw: string): string {
  const stripped = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  // Cutting at the limit can expose a dot again; the first character is never one.
  return stripped.slice(0, PROFILE_SEGMENT_MAX_LENGTH).replace(/\.+$/, '');
}

/** For names WE derive (branch names): nothing usable falls back to `default`. */
export function sanitizeProfileSegment(raw: string): string {
  return toProfileSegment(raw) || FALLBACK_PROFILE_SEGMENT;
}

// Windows maps these names (with any extension) to devices: `profiles\nul` would
// swallow every write. Derived profiles never start with one of them.
const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u;

// An explicit override is the user's stated intent: reduce it to a safe segment,
// but never invent a profile for one that reduces to nothing (`.`, `..`, `-`).
function explicitProfile(raw: string): string {
  const segment = toProfileSegment(raw);
  if (!segment) {
    throw new Error(
      `Invalid ${DB_PROFILE_ENV} ${JSON.stringify(raw)}: it reduces to an empty profile name. Use a name with at least one letter, digit or underscore.`
    );
  }
  if (WINDOWS_RESERVED_DEVICE_NAME.test(segment)) {
    throw new Error(
      `Invalid ${DB_PROFILE_ENV} ${JSON.stringify(raw)}: "${segment}" is a reserved Windows device name. Choose another profile name.`
    );
  }
  return segment;
}

function hashProfileSeed(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, WORKTREE_PROFILE_HASH_LENGTH);
}

export function createWorktreeScopedProfile(branch: string, workspaceSeed: string): string {
  const branchSegment = sanitizeProfileSegment(branch).slice(0, WORKTREE_PROFILE_BRANCH_MAX);
  return sanitizeProfileSegment(`branch-${branchSegment}-wt-${hashProfileSeed(workspaceSeed)}`);
}

// Dev shells can leak the literal string "undefined" into an exported variable.
function normalizeOverride(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Independent of any process's cwd. `path.win32.isAbsolute('\\db')` is true, but a
// drive-relative root still follows the current drive, so Windows needs a drive or UNC.
function isFullyQualified(value: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return path.posix.isAbsolute(value);
  }
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/iu.test(value);
}

// Main hands the root to the DB host and factory reset deletes under it, so a
// relative override (resolved against each process's own cwd) is refused.
function explicitRoot(raw: string, platform: NodeJS.Platform): string {
  if (!isFullyQualified(raw, platform)) {
    throw new Error(
      `Invalid ${DB_ROOT_PATH_ENV} ${JSON.stringify(raw)}: it must be an absolute path.`
    );
  }
  return raw;
}

function packagedRootPath(input: DatabaseLocationInput): string {
  const platformPath = pathFor(input.platform);
  switch (input.platform) {
    case 'darwin':
      // Application Support is Apple's app-data location; Electron's docs
      // recommend a subdirectory of userData rather than userData itself.
      return platformPath.join(input.paths.userData, PACKAGED_DATA_DIR_NAME);
    case 'win32': {
      // Non-roaming: userData lives under %APPDATA% (Roaming), which Windows
      // may sync to the cloud, and a PGlite data directory must never be.
      const localAppData = input.env.localAppData?.trim();
      if (!(localAppData && isFullyQualified(localAppData, input.platform))) {
        throw new Error(
          `Cannot resolve the packaged Windows database location: LOCALAPPDATA must be an absolute path (received ${JSON.stringify(input.env.localAppData ?? null)}). Set BRAINSTRIKE_DB_ROOT_PATH to choose a location explicitly.`
        );
      }
      return platformPath.join(localAppData, input.productDirName, PACKAGED_DATA_DIR_NAME);
    }
    case 'linux': {
      // XDG Base Directory spec: an empty or relative $XDG_DATA_HOME is invalid
      // and ignored in favour of $HOME/.local/share.
      const xdgDataHome = input.env.xdgDataHome?.trim();
      const dataHome =
        xdgDataHome && platformPath.isAbsolute(xdgDataHome)
          ? xdgDataHome
          : platformPath.join(input.paths.home, '.local', 'share');
      return platformPath.join(dataHome, input.productDirName, PACKAGED_DATA_DIR_NAME);
    }
    default:
      throw new Error(
        `Packaged desktop database location is not defined for platform "${input.platform}".`
      );
  }
}

type DerivedSource = Exclude<DatabaseLocationSource, 'override'>;

function deriveSource(input: DatabaseLocationInput): DerivedSource {
  if (input.isTestRun) {
    return 'test';
  }
  return input.isPackaged ? 'packaged' : 'development';
}

function defaultRootPath(input: DatabaseLocationInput, source: DerivedSource): string {
  switch (source) {
    case 'test':
      return input.paths.userData;
    case 'packaged':
      return packagedRootPath(input);
    case 'development':
      return pathFor(input.platform).join(input.paths.documents, DEVELOPMENT_ROOT_DIR_NAME);
  }
}

function defaultProfile(input: DatabaseLocationInput, source: DerivedSource): string {
  switch (source) {
    case 'test':
      return TEST_PROFILE;
    case 'packaged':
      return PACKAGED_PROFILE;
    case 'development': {
      const gitContext = input.readGitContext();
      if (gitContext?.branch) {
        return createWorktreeScopedProfile(gitContext.branch, gitContext.workspaceSeed);
      }
      return DEVELOPMENT_FALLBACK_PROFILE;
    }
  }
}

export function resolveDatabaseLocation(input: DatabaseLocationInput): DatabaseLocation {
  const rawRootOverride = normalizeOverride(input.env.rootOverride);
  const rootOverride =
    rawRootOverride === undefined ? undefined : explicitRoot(rawRootOverride, input.platform);
  const profileOverride = normalizeOverride(input.env.profileOverride);
  const source = deriveSource(input);
  return {
    profile:
      profileOverride === undefined
        ? defaultProfile(input, source)
        : explicitProfile(profileOverride),
    rootPath: rootOverride ?? defaultRootPath(input, source),
    source: rootOverride !== undefined && profileOverride !== undefined ? 'override' : source,
  };
}
