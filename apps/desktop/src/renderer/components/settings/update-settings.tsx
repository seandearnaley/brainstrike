import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';
import { useEffect, useState } from 'react';

type UpdateSettingsState =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'unavailable' }
  | {
      readonly betaUpdates: boolean;
      readonly error: string | null;
      readonly saving: boolean;
      readonly status: 'ready';
    };

const BETA_SWITCH_ID = 'updates-beta-toggle';

/** Settings › Updates (BST-2367): whether this install's update checks offer betas. */
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
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          Brainstrike checks for a new version each time it starts, downloads it in the background
          and installs it when you quit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium" htmlFor={BETA_SWITCH_ID}>
              Get beta updates
            </Label>
            <p className="text-muted-foreground text-sm">
              Betas bring new features first and may be less stable. The change applies at the next
              start; turning betas off keeps this version until a newer stable release is out.
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
