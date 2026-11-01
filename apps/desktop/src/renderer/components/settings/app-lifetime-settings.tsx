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
import type {
  AppLifetimeSettings,
  AppLifetimeSwitch,
} from '../../../ipc-domains/app-lifetime.contract';

type State =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'unavailable' }
  | {
      readonly error: string | null;
      readonly saving: boolean;
      readonly settings: AppLifetimeSettings;
      readonly status: 'ready';
    };

type Bridge = NonNullable<Window['appLifetime']>;

const TRAY_SWITCH_ID = 'app-lifetime-keep-running-in-tray';
const LOGIN_SWITCH_ID = 'app-lifetime-open-at-login';

function SwitchRow({
  description,
  disabled,
  id,
  label,
  onChange,
  value,
}: {
  readonly description: string;
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly onChange: (enabled: boolean) => void;
  readonly value: AppLifetimeSwitch | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label className="text-sm font-medium" htmlFor={id}>
          {label}
        </Label>
        <p className="text-muted-foreground text-sm">
          {value && !value.available ? value.reason : description}
        </p>
      </div>
      <Switch
        checked={value?.available === true && value.enabled}
        data-testid={id}
        disabled={disabled || value?.available !== true}
        id={id}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
    </div>
  );
}

/** Settings › Startup (ADR-0033): keep running in the tray when closed, and open at login. */
export function DesktopAppLifetimeSettings() {
  const bridge = window.appLifetime;
  const [state, setState] = useState<State>(() =>
    bridge
      ? { status: 'loading' }
      : { error: 'Startup settings are unavailable in this window.', status: 'unavailable' }
  );

  // biome-ignore lint/plugin: Not derived state — a one-shot async read of Main's settings over the preload bridge, which cannot be computed during render; `cancelled` discards a response that lands after unmount.
  useEffect(() => {
    let cancelled = false;
    if (!bridge) {
      return;
    }
    const load = async () => {
      try {
        const settings = await callBoundary(() => bridge.getSettings());
        if (!cancelled) {
          setState({ error: null, saving: false, settings, status: 'ready' });
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

  const write = (run: (target: Bridge) => ReturnType<Bridge['getSettings']>) => {
    if (!(bridge && state.status === 'ready')) {
      return;
    }
    const previous = state.settings;
    setState({ error: null, saving: true, settings: previous, status: 'ready' });
    callBoundary(() => run(bridge)).then(
      (settings) => setState({ error: null, saving: false, settings, status: 'ready' }),
      (error: unknown) =>
        setState({
          error: describeBoundaryError(error),
          saving: false,
          settings: previous,
          status: 'ready',
        })
    );
  };

  const settings = state.status === 'ready' ? state.settings : undefined;
  const busy = state.status !== 'ready' || state.saving;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Startup</CardTitle>
        <CardDescription>
          Runs belong to Brainstrike, not to its window: they keep going until you quit.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings?.keepRunningInTray === null ? null : (
          <SwitchRow
            description="Closing the last window leaves Brainstrike and its runs going in the system tray. Quit from the tray icon."
            disabled={busy}
            id={TRAY_SWITCH_ID}
            label="Keep running in the tray when closed"
            onChange={(enabled) => write((target) => target.setKeepRunningInTray(enabled))}
            value={settings?.keepRunningInTray}
          />
        )}
        <SwitchRow
          description="Brainstrike starts when you sign in, without opening a window."
          disabled={busy}
          id={LOGIN_SWITCH_ID}
          label="Open at login"
          onChange={(enabled) => write((target) => target.setOpenAtLogin(enabled))}
          value={settings?.openAtLogin}
        />
        {state.status !== 'loading' && state.error ? (
          <p className="text-destructive text-sm" role="alert">
            {state.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
