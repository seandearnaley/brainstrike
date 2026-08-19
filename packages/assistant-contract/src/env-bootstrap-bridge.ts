/**
 * Structural typing for the desktop `window.envBootstrap` bridge (BST-1363).
 *
 * The SINGLE source of the bridge shape: the desktop preload implements it,
 * `apps/desktop/src/types/electron.d.ts` declares it, and settings-ui consumes
 * it through the capability view. Mirrors the SecretsBridge pattern
 * (./secrets-bridge.ts), including the required-method pin consumed by the
 * desktop preload-runtime contract test.
 *
 * WHY IT EXISTS: desktop `.env` bootstrap is otherwise invisible. A single
 * malformed line makes the loader reject the WHOLE file — every variable in it
 * silently stops applying — and nothing in the UI says so. This bridge carries
 * the recorded bootstrap outcome to Settings so the failure is repairable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HARD RULE — NAMES ONLY, NEVER VALUES.
 * `credentialVariablesPresent` / `nonCredentialVariablesPresent` /
 * `deprecatedVariablesInFiles` carry variable NAMES. No field on this payload
 * may ever carry a variable's VALUE, a prefix of one, or anything derived from
 * one. The producer builds the name lists by intersecting the allow-listed
 * name sets with mere PRESENCE in the process environment, so a value has no
 * path into the payload by construction — not by filtering after the fact.
 * `apps/desktop/src/__tests__/desktop-env-report.test.ts` seeds a distinctive
 * fake key value and asserts the serialized payload does not contain it.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Which env file a report entry refers to. Mirrors the desktop loader's file ids. */
export type DesktopEnvFileId = 'dev' | 'dev-local' | 'user-data';

/**
 * Human-facing name for each env file id. These ids are internal loader
 * vocabulary: `dev-local` means nothing to a user staring at a settings
 * panel, and worse, it is not the name of a file they can go open. The loader
 * itself renders failure messages through this map, so the SAME wording
 * reaches the settings surface, the assistant status probe, and the
 * `secrets:list` error — an exhaustive Record, so adding a file id without
 * naming it fails the build rather than leaking a raw id into the UI.
 */
export const DESKTOP_ENV_FILE_LABELS: Record<DesktopEnvFileId, string> = {
  dev: '.env',
  'dev-local': '.env.local',
  'user-data': 'user-data .env',
};

/** A file the loader actually read and applied, with its absolute path. */
export interface EnvBootstrapLoadedFile {
  readonly file: DesktopEnvFileId;
  readonly path: string;
}

/**
 * One env file the loader refused. `message` is the loader's line-precise
 * text (e.g. `… is invalid at line 4: unsupported variable name.`) — the whole
 * point of the surface, so it is passed through verbatim rather than
 * re-worded. `path` lets the UI offer a reveal-in-folder affordance for a file
 * the user must go edit; it is a FILE PATH, never file CONTENT.
 */
export interface EnvBootstrapFailure {
  readonly code: 'env_file_invalid' | 'env_file_unreadable';
  readonly file: DesktopEnvFileId;
  readonly message: string;
  readonly path: string;
}

/**
 * Read-only projection of the recorded desktop env bootstrap.
 *
 * `appliedVariableCount` counts variables the files actually applied (an
 * inherited process variable wins, so it is not counted). The two
 * `…VariablesPresent` lists describe the EFFECTIVE environment — every
 * allow-listed name currently set, whichever source set it — because that is
 * what a user debugging "why is my key not picked up" needs to see.
 */
export interface EnvBootstrapReport {
  readonly appliedVariableCount: number;
  /** Allow-listed CREDENTIAL names currently set. Names only — never values. */
  readonly credentialVariablesPresent: readonly string[];
  /** Retired names spelled in the loaded files; the user should rename them. */
  readonly deprecatedVariablesInFiles: readonly string[];
  readonly failures: readonly EnvBootstrapFailure[];
  readonly loadedFiles: readonly EnvBootstrapLoadedFile[];
  /** Allow-listed NON-credential names currently set (e.g. AWS_REGION). */
  readonly nonCredentialVariablesPresent: readonly string[];
  /** True when env-file loading was disabled outright (test mode). */
  readonly skipped: boolean;
}

export interface EnvBootstrapBridge {
  read: () => Promise<EnvBootstrapReport>;
}

// Compile-time exact-set proof: `satisfies Record<keyof EnvBootstrapBridge,
// true>` fails the build if any interface method is missing here, and excess
// keys are rejected — the pin can never silently become a subset (or superset)
// of the interface.
const ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHOD_SET = {
  read: true,
} as const satisfies Record<keyof EnvBootstrapBridge, true>;

/**
 * Every method name the preload's `window.envBootstrap` surface must expose.
 * Exported so the desktop preload-runtime contract test can pin the
 * `exposeInMainWorld('envBootstrap', …)` key set to this exact list.
 */
export const ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHODS = Object.keys(
  ENV_BOOTSTRAP_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof EnvBootstrapBridge)[];

/**
 * Capability view consumed by settings-ui. The bridge is absent on web (no
 * preload), so the settings section is gated on this resolving — never on an
 * `isElectron()` check.
 */
export type EnvBootstrapCapability = EnvBootstrapBridge;
