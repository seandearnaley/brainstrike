import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '../button';
import { useRequestAppReload } from './app-reload-context';
import { useAppReloadState } from './app-reload-store';

/** Persistent app-level notice shown once a lazy chunk has failed to load. */
export function AppReloadNotice(): ReactElement | null {
  const { reloadAlreadyAttempted, required } = useAppReloadState();
  // Called before the early return so missing wiring fails at mount, not on first failure.
  const requestAppReload = useRequestAppReload();
  if (!required) {
    return null;
  }
  return (
    <div
      className="flex items-center gap-3 border-destructive/30 border-b bg-destructive/10 px-4 py-2 text-sm"
      data-slot="app-reload-notice"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1">
        {reloadAlreadyAttempted
          ? "Part of BrainStrike still can't load. Reloading didn't fix this."
          : 'Part of BrainStrike failed to load. Reload the app to fix it.'}
      </p>
      <Button onClick={() => requestAppReload()} size="sm" type="button" variant="outline">
        <RotateCw aria-hidden="true" />
        Reload app
      </Button>
    </div>
  );
}
