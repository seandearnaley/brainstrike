import type {
  DesktopEnvFileId,
  EnvBootstrapFailure,
  EnvBootstrapReport,
} from '@brainstrike/assistant-contract/env-bootstrap-bridge';
import { SECRETS_CHANGED_EVENT_NAME } from '@brainstrike/assistant-contract/provider-key-resolution';
import { Button } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getEnvBootstrapCapability } from './env-bootstrap-capability';
import {
  buildDeprecatedEnvVariableRenameIndex,
  buildEnvVariableSlotIndex,
} from './env-variable-index';

/**
 * Human labels for the loader's file ids. An exhaustive Record: adding a file
 * id to the contract without labelling it here fails the build rather than
 * rendering a raw id.
 */
const FILE_LABELS: Record<DesktopEnvFileId, string> = {
  dev: '.env',
  'dev-local': '.env.local',
  'user-data': 'user-data .env',
};

const CHIP_BASE_CLASS = 'rounded border px-1.5 py-0.5 font-mono text-xs';
const CREDENTIAL_CHIP_CLASS = `${CHIP_BASE_CLASS} border-primary/40 bg-primary/10 text-foreground`;
const CONFIG_CHIP_CLASS = `${CHIP_BASE_CLASS} border-border bg-muted text-muted-foreground`;

type LoadState =
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly report: EnvBootstrapReport };

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The environment bootstrap report could not be read.';
}

function summaryText(report: EnvBootstrapReport): string {
  if (report.skipped) {
    return 'Environment files disabled (test mode)';
  }
  if (report.loadedFiles.length === 0) {
    return 'Environment: no .env file loaded';
  }
  const labels = report.loadedFiles.map(({ file }) => FILE_LABELS[file]).join(' + ');
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
      <p className="font-medium">{FILE_LABELS[failure.file]} was not applied</p>
      <p className="mt-1">{failure.message}</p>
      <p className="mt-1 text-xs opacity-80">
        No variable from this file is set. Fix the line above and restart.
      </p>
    </div>
  );
}

export interface EnvironmentSectionProps {
  /**
   * Reveals a path in the OS file manager. INJECTED and capability-gated: the
   * host passes it only when the desktop shell bridge resolves, so this
   * package never reaches for `window.platform` itself.
   */
  readonly onRevealPath?: ((absolutePath: string) => void) | undefined;
  /** Scrolls to and highlights the Credential Inventory row for a slot id. */
  readonly onSelectCredentialSlot?: ((slotId: string) => void) | undefined;
}

/**
 * Read-only visibility into the desktop `.env` bootstrap (BST-1363).
 *
 * WHY IT EXISTS: a single malformed line makes the loader reject the WHOLE
 * file, so every key in it silently stops applying and the app behaves as if
 * the keys were never set. That failure class was previously invisible. This
 * section states which files loaded, what failed and on which line, and which
 * allow-listed variable NAMES are in effect — never their values.
 *
 * Deliberately NOT an editor: env files are edited in the user's own editor,
 * and the values are secrets this surface must never handle.
 *
 * @platform desktop
 */
export function EnvironmentSection({
  onRevealPath,
  onSelectCredentialSlot,
}: EnvironmentSectionProps = {}) {
  // The preload bridge cannot appear mid-session, so it is resolved once.
  const capability = useMemo(() => getEnvBootstrapCapability(), []);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Monotonic request id: an in-flight read that resolves after a newer one
  // must not overwrite the newer result.
  const requestIdRef = useRef(0);

  const read = capability?.read;
  const refresh = useCallback(async () => {
    if (!read) {
      return;
    }
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    try {
      const report = await read();
      if (requestIdRef.current === requestId) {
        setState({ report, status: 'ready' });
      }
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setState({ message: toErrorMessage(error), status: 'error' });
      }
    }
  }, [read]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A credential save/delete can change which names are effective, and env
  // files change outside the app entirely — so a focus return re-reads too.
  useEffect(() => {
    const handle = () => {
      void refresh();
    };
    window.addEventListener(SECRETS_CHANGED_EVENT_NAME, handle);
    window.addEventListener('focus', handle);
    return () => {
      window.removeEventListener(SECRETS_CHANGED_EVENT_NAME, handle);
      window.removeEventListener('focus', handle);
    };
  }, [refresh]);

  const slotIndex = useMemo(() => buildEnvVariableSlotIndex(), []);
  const renameIndex = useMemo(() => buildDeprecatedEnvVariableRenameIndex(), []);

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
  const deprecatedNames = new Set(report.deprecatedVariablesInFiles);
  // A retired name is reported ONCE, as a rename warning — never also as an
  // ordinary chip, which would read as an endorsement of the retired spelling.
  const credentialChips = report.credentialVariablesPresent.filter(
    (name) => !deprecatedNames.has(name)
  );
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
            onClick={() => onRevealPath(revealTarget)}
            size="sm"
            variant="secondary"
          >
            Open folder
          </Button>
        ) : null}
      </div>

      {report.failures.map((failure) => (
        <FailureBanner failure={failure} key={failure.file} />
      ))}

      {report.deprecatedVariablesInFiles.map((name) => (
        <p
          className="text-amber-700 text-xs dark:text-amber-500"
          data-testid={`env-bootstrap-deprecated-${name}`}
          key={name}
        >
          <span className="font-mono">{name}</span> is no longer read — rename it to{' '}
          <span className="font-mono">{renameIndex.get(name) ?? 'the current name'}</span>.
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
