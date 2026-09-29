import { createHash } from 'node:crypto';
import path from 'node:path';

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
    readonly profileOverride?: string | undefined;
    readonly rootOverride?: string | undefined;
    readonly xdgDataHome?: string | undefined;
  };
  readonly isPackaged: boolean;
  /** `NODE_ENV === 'test'` or `--test-mode`: isolate into userData. */
  readonly isTestRun: boolean;
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

export function sanitizeProfileSegment(raw: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    return 'default';
  }
  return sanitized.slice(0, 64);
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
      if (!(localAppData && platformPath.isAbsolute(localAppData))) {
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
  const rootOverride = normalizeOverride(input.env.rootOverride);
  const profileOverride = normalizeOverride(input.env.profileOverride);
  const source = deriveSource(input);
  return {
    profile:
      profileOverride === undefined
        ? defaultProfile(input, source)
        : sanitizeProfileSegment(profileOverride),
    rootPath: rootOverride ?? defaultRootPath(input, source),
    source: rootOverride !== undefined && profileOverride !== undefined ? 'override' : source,
  };
}
