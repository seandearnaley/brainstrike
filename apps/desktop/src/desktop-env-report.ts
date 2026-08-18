/**
 * Projects the RECORDED desktop env bootstrap into the read-only settings
 * payload (BST-1363).
 *
 * WHY: env-file bootstrap is otherwise invisible. One malformed line makes the
 * loader reject the WHOLE file, so every variable in it silently stops
 * applying and the app just behaves as if the keys were never set. This module
 * turns that into a repairable, line-precise statement in Settings.
 *
 * NAMES ONLY, NEVER VALUES. The two presence lists are built by intersecting
 * the allow-listed NAME sets with mere presence in the environment — a value
 * is read solely to ask "is this non-blank?" and is never copied, hashed,
 * truncated, or otherwise carried into the result. That is a construction
 * guarantee, not a post-hoc scrub.
 */

import type {
  EnvBootstrapFailure,
  EnvBootstrapLoadedFile,
  EnvBootstrapReport,
} from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import {
  buildDesktopEnvCandidates,
  CREDENTIAL_ENV_FILE_VARIABLE_NAMES,
  type DesktopEnvFile,
  type DesktopEnvLoadResult,
  NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES,
} from './desktop-env';

// Union drift is caught by the assignments below: mapping the loader's
// `DesktopEnvFile` entries into `EnvBootstrapLoadedFile`/`EnvBootstrapFailure`
// fails the build if the loader ever grows a file id the wire type lacks.

export interface BuildDesktopEnvBootstrapReportOptions {
  readonly appRoot: string;
  /** Read for PRESENCE only — no value from this object reaches the result. */
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly isPackaged: boolean;
  /** The recorded bootstrap result. Loading is NEVER re-run to build a report. */
  readonly result: DesktopEnvLoadResult;
  readonly userDataPath: string;
}

/**
 * The set of environment names holding a non-blank value, upper-cased.
 *
 * Windows environment names are case-insensitive. Apply the same rule on
 * every platform — mirroring `createCredentialIsolatedChildEnvironment` and
 * `detectDeprecatedProviderEnvVars` — so a mixed-case source object cannot
 * dodge this report while still resolving as a real credential. Reports
 * always carry the canonical (uppercase) allow-list spelling.
 *
 * A variable counts as present only when its value is non-blank: an empty or
 * whitespace-only assignment authenticates nothing, so showing it as a
 * configured chip would be a lie.
 */
function upperCasedPresentNames(env: Readonly<NodeJS.ProcessEnv>): ReadonlySet<string> {
  const present = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      present.add(name.toUpperCase());
    }
  }
  return present;
}

/** Allow-listed names currently set, in stable sorted order. Names only. */
function presentNames(
  allowedNames: ReadonlySet<string>,
  presentEnvNames: ReadonlySet<string>
): string[] {
  return [...allowedNames].filter((name) => presentEnvNames.has(name)).sort();
}

export function buildDesktopEnvBootstrapReport({
  appRoot,
  env,
  isPackaged,
  result,
  userDataPath,
}: BuildDesktopEnvBootstrapReportOptions): EnvBootstrapReport {
  // Paths come from the loader's OWN candidate builder, so a path rendered in
  // Settings is by construction a path the loader actually considered.
  const candidatePaths = new Map<DesktopEnvFile, string>(
    buildDesktopEnvCandidates(appRoot, userDataPath, isPackaged).map(
      ({ file, path }) => [file, path] as const
    )
  );

  const pathFor = (file: DesktopEnvFile): string => {
    const candidatePath = candidatePaths.get(file);
    if (candidatePath === undefined) {
      // A recorded file id with no candidate in the current mode means the
      // recorded result and this runtime disagree about the launch mode.
      // Surfacing a report that omits the entry would hide that; throw.
      throw new Error(
        `Desktop env bootstrap recorded file "${file}" has no candidate path for this launch mode.`
      );
    }
    return candidatePath;
  };

  const loadedFiles: EnvBootstrapLoadedFile[] = result.loadedFiles.map((file) => ({
    file,
    path: pathFor(file),
  }));

  const failures: EnvBootstrapFailure[] = result.failures.map(({ code, file, message }) => ({
    code,
    file,
    message,
    path: pathFor(file),
  }));

  const presentEnvNames = upperCasedPresentNames(env);

  return {
    appliedVariableCount: result.appliedVariableCount,
    credentialVariablesPresent: presentNames(CREDENTIAL_ENV_FILE_VARIABLE_NAMES, presentEnvNames),
    deprecatedVariablesInFiles: [...result.deprecatedVariableNames],
    failures,
    loadedFiles,
    nonCredentialVariablesPresent: presentNames(
      NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES,
      presentEnvNames
    ),
    skipped: result.skipped,
  };
}
