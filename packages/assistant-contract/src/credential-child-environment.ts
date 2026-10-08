/**
 * Credential names and the credential-isolated child environment, shared by
 * every Node composition that spawns repository-controlled children (desktop
 * command/skill/hook children and the agent host's hooks, desktop or CLI).
 * Moved here from `apps/desktop/src/desktop-env.ts` so the CLI host scrubs the
 * same names: a second hand-written list would silently drift.
 */
import { listProviders, providerDeprecatedEnvKeys, providerEnvKeys } from './provider-metadata.js';
import { TAVILY_ENV_KEYS } from './tavily-env-keys.js';

/**
 * Registry-derived credential names a `.env` FILE may set (BST-1361, split in
 * BST-1350). Deprecated names stay here forever: an unrecognized name rejects
 * the WHOLE file, so dropping them would brick existing user files.
 *
 * Derived from the shared provider registry plus the Tavily names rather than
 * hand-copied — a hand-written list silently drifts.
 *
 * This set is FILE-LOADABILITY ONLY. The child-process scrub is driven by
 * {@link SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES}, which is a strict superset;
 * see the security note there for why the two roles cannot share one constant.
 */
export const CREDENTIAL_ENV_FILE_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...listProviders().flatMap((definition) => [
    ...providerEnvKeys(definition.id),
    ...providerDeprecatedEnvKeys(definition.id),
  ]),
  ...TAVILY_ENV_KEYS,
]);

/**
 * Credential names ambient in the process environment that are NOT
 * `.env`-file loadable (PR #2525 review, finding 1). Scrub-only.
 *
 * AWS static credentials arrive from the user's SHELL, not from our env
 * files: BST-1353 documents `AWS_ACCESS_KEY_ID` as one of the names that
 * ACTIVATES the credential chain, so they are routinely present in a real
 * process env. They must never become file-settable (that would hand a
 * `<userData>/.env` write a brand-new credential channel), but they
 * absolutely must be scrubbed from child environments.
 */
const AMBIENT_ONLY_CREDENTIAL_ENV_VARIABLE_NAMES: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
];

/**
 * Every credential name removed from a non-interactive child's environment
 * (the main-process env reaches children; non-interactive command, skill, and
 * hook children strip these, while interactive PTYs and runtime-support
 * children intentionally retain the parent env).
 *
 * SECURITY — WHY THIS IS SEPARATE FROM THE FILE SET (PR #2525 review,
 * finding 1). `createCredentialIsolatedChildEnvironment` is a DENY-LIST: it
 * copies every name that is NOT in this set. So "absent from every set" does
 * not mean "protected" — it means "passed through VERBATIM". A credential
 * that is ambient-but-not-file-loadable therefore needs explicit membership
 * HERE.
 *
 * INVARIANT: this set is a strict superset of
 * {@link CREDENTIAL_ENV_FILE_VARIABLE_NAMES} — anything a file may set is by
 * definition credential-shaped enough to scrub.
 */
export const SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES: ReadonlySet<string> = new Set<string>([
  ...CREDENTIAL_ENV_FILE_VARIABLE_NAMES,
  ...AMBIENT_ONLY_CREDENTIAL_ENV_VARIABLE_NAMES,
]);

/** A copy of `source` without any credential name (case-insensitive). */
export function createCredentialIsolatedChildEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    // Windows environment names are case-insensitive. Apply the same rule on
    // every platform so a mixed-case source object cannot bypass this boundary
    // in tests, IPC adapters, or a future cross-platform caller.
    if (!SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}
