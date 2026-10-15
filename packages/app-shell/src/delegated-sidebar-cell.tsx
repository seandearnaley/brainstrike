import { Button } from '@brainstrike/ui';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';

/** An expanded host thread's loading, empty or error state beneath it. */
export function DelegatedSidebarCell({
  row,
}: {
  readonly row: Extract<DelegatedSidebarRow, { kind: 'delegated-state' }>;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 text-xs ${row.isError ? 'text-destructive' : 'text-muted-foreground'}`}
      role={row.isError ? 'alert' : 'status'}
    >
      <span>{row.label}</span>
      {row.onRetry ? (
        <Button
          aria-label="Retry loading child conversations"
          onClick={(event) => {
            event.stopPropagation();
            row.onRetry?.();
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
