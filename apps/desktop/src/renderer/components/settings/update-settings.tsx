import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { useEffect, useRef, useState } from 'react';
import type { AppUpdateStatus } from '../../../ipc-domains/app-updates.contract';

type UpdateSettingsState =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'unavailable' }
  | {
      readonly betaUpdates: boolean;
      readonly error: string | null;
      readonly saving: boolean;
      readonly status: 'ready';
    };

interface UpdateStatusState {
  readonly error: string | null;
  readonly requesting: boolean;
  readonly update: AppUpdateStatus | null;
}

const BETA_SWITCH_ID = 'updates-beta-toggle';

/** One line for where updates stand (BST-2356). */
export function describeUpdateStatus(update: AppUpdateStatus): string {
  switch (update.state) {
    case 'off':
      return update.reason === 'reset'
        ? 'Update checks resume the next time Brainstrike starts.'
        : 'This copy was not installed from a release, so it does not update itself.';
    case 'idle':
      return 'Brainstrike checks for updates when it starts and every few hours.';
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return 'Brainstrike is up to date.';
    case 'downloading':
      return `Downloading version ${update.version}…`;
    case 'ready':
      return `Version ${update.version} is ready to install.`;
    case 'failed':
      return update.step === 'download'
        ? `Couldn't download the update: ${update.message}`
        : `Couldn't check for updates: ${update.message}`;
    default:
      return update satisfies never;
  }
}

/** Where updates stand, with Check now, or Restart to update once one is downloaded. */
function UpdateStatusRow({ bridge }: { readonly bridge: NonNullable<Window['appUpdates']> }) {
  const [state, setState] = useState<UpdateStatusState>({
    error: null,
    requesting: false,
    update: null,
  });
  // Main pushes every status change. A request's answer is a snapshot taken
  // earlier, so a push that lands while the request is out is newer than it.
  const pushes = useRef(0);

  // biome-ignore lint/plugin: Not derived state — an async read of Main's update status over the preload bridge, then every status Main pushes; `cancelled` discards a response that lands after unmount.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = bridge.onStatusChange((update) => {
      pushes.current += 1;
      setState((previous) => ({ ...previous, update }));
    });
    const load = async () => {
      try {
        const update = await callBoundary(() => bridge.getStatus());
        if (!cancelled) {
          setState((previous) => ({ ...previous, update: previous.update ?? update }));
        }
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({ ...previous, error: describeBoundaryError(error) }));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const request = (run: () => Promise<AppUpdateStatus | undefined>) => {
    setState((previous) => ({ ...previous, error: null, requesting: true }));
    const pushesBefore = pushes.current;
    run().then(
      (answer) => {
        const update = pushes.current === pushesBefore ? answer : undefined;
        setState((previous) => ({
          error: null,
          requesting: false,
          update: update ?? previous.update,
        }));
      },
      (error: unknown) => {
        setState((previous) => ({
          ...previous,
          error: describeBoundaryError(error),
          requesting: false,
        }));
      }
    );
  };

  const { update } = state;
  const busy = state.requesting || update?.state === 'checking' || update?.state === 'downloading';
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-1">
        <p className="text-sm" data-testid="updates-status" role="status">
          {update ? describeUpdateStatus(update) : 'Reading the update status…'}
        </p>
        {state.error ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error}
          </p>
        ) : null}
      </div>
      {update?.state === 'ready' ? (
        <Button
          data-testid="updates-restart"
          disabled={state.requesting}
          onClick={() =>
            request(async () => {
              await callBoundary(() => bridge.restartToUpdate());
              return;
            })
          }
          size="sm"
        >
          Restart to update
        </Button>
      ) : null}
      {update && update.state !== 'ready' && update.state !== 'off' ? (
        <Button
          data-testid="updates-check-now"
          disabled={busy}
          onClick={() => request(() => callBoundary(() => bridge.checkNow()))}
          size="sm"
          variant="outline"
        >
          Check now
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Settings › Updates: where this install's updates stand (BST-2356) and
 * whether its update checks offer betas (BST-2367).
 */
export function DesktopUpdateSettings() {
  const bridge = window.appUpdates;
  const [state, setState] = useState<UpdateSettingsState>(() =>
    bridge
      ? { status: 'loading' }
      : { error: 'Updates are unavailable in this window.', status: 'unavailable' }
  );

  // biome-ignore lint/plugin: Not derived state — a one-shot async read of Main's stored preference over the preload bridge, which cannot be computed during render; `cancelled` discards a response that lands after unmount.
  useEffect(() => {
    let cancelled = false;
    if (!bridge) {
      return;
    }
    const load = async () => {
      try {
        const { betaUpdates } = await callBoundary(() => bridge.getPreferences());
        if (!cancelled) {
          setState({ betaUpdates, error: null, saving: false, status: 'ready' });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ error: describeBoundaryError(error), status: 'unavailable' });
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setBetaUpdates = (enabled: boolean) => {
    if (!(bridge && state.status === 'ready')) {
      return;
    }
    const previous = state.betaUpdates;
    setState({ betaUpdates: enabled, error: null, saving: true, status: 'ready' });
    callBoundary(() => bridge.setBetaUpdates(enabled)).then(
      ({ betaUpdates }) => {
        setState({ betaUpdates, error: null, saving: false, status: 'ready' });
      },
      (error: unknown) => {
        setState({
          betaUpdates: previous,
          error: describeBoundaryError(error),
          saving: false,
          status: 'ready',
        });
      }
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic updates</CardTitle>
        <CardDescription>
          Brainstrike checks for a new version when it starts and every few hours, downloads it in
          the background and installs it when you quit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {bridge ? <UpdateStatusRow bridge={bridge} /> : null}
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium" htmlFor={BETA_SWITCH_ID}>
              Get beta updates
            </Label>
            <p className="text-muted-foreground text-sm">
              Betas bring new features first and may be less stable. The change applies at the next
              check; turning betas off keeps this version until a newer stable release is out.
            </p>
          </div>
          <Switch
            checked={state.status === 'ready' && state.betaUpdates}
            data-testid={BETA_SWITCH_ID}
            disabled={state.status !== 'ready' || state.saving}
            id={BETA_SWITCH_ID}
            onCheckedChange={(value) => setBetaUpdates(value === true)}
          />
        </div>
        {state.status !== 'loading' && state.error ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
