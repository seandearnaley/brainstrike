import type { DeprecatedEnvVarReport } from '@brainstrike/assistant-contract';
import {
  DESKTOP_ENV_FILE_LABELS,
  type EnvBootstrapFailure,
  type EnvBootstrapReport,
} from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { Button } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deprecatedEnvVarMessage } from '../deprecated-env-var-message';
import { getEnvBootstrapCapability } from './env-bootstrap-capability';
import { buildDeprecatedEnvVariableNameSet, buildEnvVariableSlotIndex } from './env-variable-index';

const CHIP_BASE_CLASS = 'rounded border px-1.5 py-0.5 font-mono text-xs';
const CREDENTIAL_CHIP_CLASS = `${CHIP_BASE_CLASS} border-primary/40 bg-primary/10 text-foreground`;
const CONFIG_CHIP_CLASS = `${CHIP_BASE_CLASS} border-border bg-muted text-muted-foreground`;

const EMPTY_DEPRECATED_ENV_VARS: readonly DeprecatedEnvVarReport[] = Object.freeze([]);

type LoadState =
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: EnvBootstrapReport };

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function summaryText(report: EnvBootstrapReport): string {
  if (report.skipped) {
    return 'Environment files disabled (test mode)';
  }
  if (report.loadedFiles.length === 0) {
    return 'Environment: no .env file loaded';
  }
  const labels = report.loadedFiles.map(({ file }) => DESKTOP_ENV_FILE_LABELS[file]).join(' + ');
  const count = report.appliedVariableCount;
  return `Environment: ${labels} loaded, ${count} ${count === 1 ? 'variable' : 'variables'} applied`;
}

/**
 * The user-data `.env` path, whether it loaded or FAILED to load. A failed
 * packaged file is exactly when the user most needs to be shown where it
 * lives, so the reveal target is taken from either list.
 */
function userDataEnvPath(report: EnvBootstrapReport): string | undefined {
  return (
    report.loadedFiles.find(({ file }) => file === 'user-data')?.path ??
    report.failures.find(({ file }) => file === 'user-data')?.path
  );
}

function FailureBanner({ failure }: { readonly failure: EnvBootstrapFailure }) {
  return (
    <div
      className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-destructive text-sm"
      data-testid={`env-bootstrap-failure-${failure.file}`}
      role="alert"
    >
      <p className="font-medium">{DESKTOP_ENV_FILE_LABELS[failure.file]} was not applied</p>
      {/* The loader's own line-precise text, verbatim — it already names the
          file by its real filename, so no internal id reaches the user. */}
      <p className="mt-1">{failure.message}</p>
      <p className="mt-1 text-xs opacity-80">
        No environment file was applied — one invalid file discards them all. Fix the line above and
        restart.
      </p>
    </div>
  );
}

export interface EnvironmentSectionProps {
  /**
   * Deprecated env names found set, from the assistant status probe — the
   * SAME reports the inventory rows render (BST-1361). This section must not
   * derive its own rename target: the report's `replacement` is the
   * vendor-standard name, and a second derivation drifted from it.
   */
  readonly deprecatedEnvVars?: readonly DeprecatedEnvVarReport[] | undefined;
  /**
   * Reveals an env file in the OS file manager. INJECTED by the host and
   * capability-gated on the desktop shell bridge — this package never reaches
   * for `window.platform`, and web simply never passes it. Resolves the
   * shell's `{ ok, error }` result so a failed reveal can be shown rather
   * than silently doing nothing.
   */
  readonly onRevealPath?:
    | ((absolutePath: string) => Promise<{ ok: boolean; error?: string }>)
    | undefined;
  /** Scrolls to and highlights the Credential Inventory row for a slot id. */
  readonly onSelectCredentialSlot?: ((slotId: string) => void) | undefined;
}

/**
 * Read-only visibility into the desktop `.env` bootstrap (BST-1363).
 *
 * WHY IT EXISTS: a single malformed line makes the loader reject the WHOLE
 * set of env files, so every key in them silently stops applying and the app
 * behaves as if the keys were never set. That failure class was previously
 * invisible. This section states which files loaded, what failed and on which
 * line, and which allow-listed variable NAMES are in effect — never values.
 *
 * Deliberately NOT an editor: env files are edited in the user's own editor,
 * and the values are secrets this surface must never handle.
 *
 * Read ONCE on mount. The payload is derived from the recorded bootstrap plus
 * the process environment, and neither can change without a restart — so a
 * refresh subscription could only ever re-fetch an identical payload while
 * implying the panel is live. The restart note below is the honest contract.
 *
 * @platform desktop
 */
export function EnvironmentSection({
  deprecatedEnvVars = EMPTY_DEPRECATED_ENV_VARS,
  onRevealPath,
  onSelectCredentialSlot,
}: EnvironmentSectionProps = {}) {
  // The preload bridge cannot appear mid-session, so it is resolved once.
  const capability = useMemo(() => getEnvBootstrapCapability(), []);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [revealError, setRevealError] = useState<string | null>(null);

  const read = capability?.read;
  // biome-ignore lint/plugin: Not derived state — this is a one-shot async READ of an external system (the desktop IPC bridge) whose result cannot be computed during render. The `active` flag discards a response that arrives after unmount rather than chaining updates.
  useEffect(() => {
    if (!read) {
      return;
    }
    let active = true;
    read()
      .then((report) => {
        if (active) {
          setState({ report, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            message: toErrorMessage(error, 'The environment report could not be read.'),
            status: 'error',
          });
        }
      });
    return () => {
      active = false;
    };
  }, [read]);

  const slotIndex = useMemo(() => buildEnvVariableSlotIndex(), []);
  const deprecatedNames = useMemo(() => buildDeprecatedEnvVariableNameSet(), []);
  const replacementByName = useMemo(() => {
    const byName = new Map<string, string>();
    for (const report of deprecatedEnvVars) {
      byName.set(report.envVar, report.replacement);
    }
    return byName;
  }, [deprecatedEnvVars]);

  const handleReveal = useCallback(
    async (absolutePath: string) => {
      if (!onRevealPath) {
        return;
      }
      setRevealError(null);
      try {
        const result = await onRevealPath(absolutePath);
        if (!result.ok) {
          setRevealError(`Could not open ${absolutePath}: ${result.error ?? 'Reveal failed'}`);
        }
      } catch (error) {
        setRevealError(`Could not open ${absolutePath}: ${toErrorMessage(error, 'Reveal failed')}`);
      }
    },
    [onRevealPath]
  );

  if (!capability) {
    return null;
  }

  if (state.status === 'error') {
    return (
      <div
        className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-destructive text-sm"
        data-testid="env-bootstrap-error"
        role="alert"
      >
        {state.message}
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div
        className="h-5 w-64 animate-pulse rounded bg-muted"
        data-testid="env-bootstrap-skeleton"
      />
    );
  }

  const { report } = state;
  // A retired name is reported ONCE, as a rename warning — never also as an
  // ordinary chip, which would read as an endorsement of the dead spelling.
  const credentialChips = report.credentialVariablesPresent.filter(
    (name) => !deprecatedNames.has(name)
  );
  // Retired names worth warning about: set in the environment, or spelled in
  // a loaded file. The file case adds provenance; both are equally dead.
  const spelledInFile = new Set(report.deprecatedVariablesInFiles);
  const retiredNames = [
    ...new Set(
      [...report.credentialVariablesPresent, ...report.deprecatedVariablesInFiles].filter((name) =>
        deprecatedNames.has(name)
      )
    ),
  ].sort();
  const revealTarget = userDataEnvPath(report);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm" data-testid="env-bootstrap-summary">
          {summaryText(report)}
        </p>
        {onRevealPath && revealTarget ? (
          <Button
            data-testid="env-bootstrap-open-folder"
            onClick={() => void handleReveal(revealTarget)}
            size="sm"
            variant="secondary"
          >
            Open folder
          </Button>
        ) : null}
      </div>

      {revealError ? (
        <p
          className="text-destructive text-xs"
          data-testid="env-bootstrap-reveal-error"
          role="alert"
        >
          {revealError}
        </p>
      ) : null}

      {report.failures.map((failure) => (
        <FailureBanner failure={failure} key={failure.file} />
      ))}

      {retiredNames.map((name) => (
        <p
          className="text-warning text-xs"
          data-testid={`env-bootstrap-deprecated-${name}`}
          key={name}
        >
          {deprecatedEnvVarMessage({
            envVar: name,
            replacement: replacementByName.get(name),
            spelledInEnvFile: spelledInFile.has(name),
          })}
        </p>
      ))}

      {credentialChips.length > 0 || report.nonCredentialVariablesPresent.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {credentialChips.map((name) => {
            const slotId = slotIndex.get(name);
            if (!(slotId && onSelectCredentialSlot)) {
              return (
                <span
                  className={CREDENTIAL_CHIP_CLASS}
                  data-testid={`env-bootstrap-chip-${name}`}
                  data-variable-kind="credential"
                  key={name}
                >
                  {name}
                </span>
              );
            }
            return (
              <button
                className={`${CREDENTIAL_CHIP_CLASS} hover:bg-primary/20`}
                data-testid={`env-bootstrap-chip-${name}`}
                data-variable-kind="credential"
                key={name}
                onClick={() => onSelectCredentialSlot(slotId)}
                title={`Show the ${name} row in the Credential Inventory`}
                type="button"
              >
                {name}
              </button>
            );
          })}
          {report.nonCredentialVariablesPresent.map((name) => (
            <span
              className={CONFIG_CHIP_CLASS}
              data-testid={`env-bootstrap-chip-${name}`}
              data-variable-kind="config"
              key={name}
            >
              {name}
            </span>
          ))}
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs" data-testid="env-bootstrap-restart-note">
        Changes to environment files apply after restart.
      </p>
    </div>
  );
}
