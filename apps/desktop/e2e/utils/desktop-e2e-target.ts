import { accessSync, constants, statSync } from 'node:fs';
import { packagedDesktopExecutablePath } from './packaged-electron';

/**
 * Which desktop build the shared Electron harness launches (BST-2190).
 *
 * Unset, it launches the dev build: the workspace Electron with `dist/main.js`.
 * `packaged` launches the electron-builder output that
 * `pnpm --filter @brainstrike/desktop run pack` writes under `release/`, at the
 * path `packagedDesktopExecutablePath` owns, so the same specs qualify the app
 * as it ships. Any other value, or a packaged executable that is missing, fails
 * the run: it never falls back to the dev build.
 */
export const DESKTOP_E2E_TARGET_ENV = 'BRAINSTRIKE_E2E_DESKTOP_TARGET';

export type DesktopE2eTarget =
  | { readonly kind: 'dev' }
  | { readonly executablePath: string; readonly kind: 'packaged' };

export function resolveDesktopE2eTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
  packagedExecutablePath: () => string = packagedDesktopExecutablePath
): DesktopE2eTarget {
  const value = env[DESKTOP_E2E_TARGET_ENV];
  if (value === undefined) {
    return { kind: 'dev' };
  }
  if (value !== 'packaged') {
    throw new Error(
      `${DESKTOP_E2E_TARGET_ENV}=${JSON.stringify(value)} is not supported: set it to "packaged", or leave it unset for the dev build.`
    );
  }
  const executablePath = packagedExecutablePath();
  assertPackagedExecutable(executablePath);
  return { executablePath, kind: 'packaged' };
}

function assertPackagedExecutable(executablePath: string): void {
  const produce = 'Package it first: pnpm --filter @brainstrike/desktop run pack.';
  let isFile: boolean;
  try {
    isFile = statSync(executablePath).isFile();
  } catch (error) {
    throw new Error(
      `${DESKTOP_E2E_TARGET_ENV}=packaged, but the packaged executable ${executablePath} does not exist. ${produce}`,
      { cause: error }
    );
  }
  if (!isFile) {
    throw new Error(
      `${DESKTOP_E2E_TARGET_ENV}=packaged, but ${executablePath} is not a file. ${produce}`
    );
  }
  try {
    accessSync(executablePath, constants.X_OK);
  } catch (error) {
    throw new Error(
      `${DESKTOP_E2E_TARGET_ENV}=packaged, but ${executablePath} is not executable. ${produce}`,
      { cause: error }
    );
  }
}

/**
 * Checks the launched process is the build the target named: `app.isPackaged`
 * is Electron's own answer, so a dev Electron handed in as the packaged
 * executable (or the reverse) fails here instead of running the lane.
 */
export function assertLaunchedDesktopTarget(target: DesktopE2eTarget, isPackaged: boolean): void {
  if (target.kind === 'packaged' && !isPackaged) {
    throw new Error(
      `${DESKTOP_E2E_TARGET_ENV}=packaged launched ${target.executablePath}, but that process reports app.isPackaged=false.`
    );
  }
  if (target.kind === 'dev' && isPackaged) {
    throw new Error('The dev build target launched a process that reports app.isPackaged=true.');
  }
}
