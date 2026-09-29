import { Button } from '@brainstrike/ui';
import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { usePendingReload } from './pending-reload-context';

/** Persistent strip shown while the app waits for the running assistant work to finish. */
export function AppReloadPendingBanner(): ReactElement | null {
  const pendingReload = usePendingReload();
  if (pendingReload === null) {
    return null;
  }
  return (
    <div
      className="flex items-center gap-3 border-border border-b bg-muted px-4 py-2 text-sm"
      data-slot="app-reload-pending-banner"
      data-testid="app-reload-pending-banner"
      role="status"
    >
      <Loader2
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <p className="min-w-0 flex-1">BrainStrike will reload when the current run finishes.</p>
      <Button onClick={pendingReload.cancel} size="sm" type="button" variant="outline">
        Cancel
      </Button>
    </div>
  );
}
