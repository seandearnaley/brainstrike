import type { DelegatedSidebarRow } from './delegated-sidebar-rows';

/** An expanded host thread's loading, empty or error state beneath it. */
export function DelegatedSidebarCell({
  row,
}: {
  readonly row: Extract<DelegatedSidebarRow, { kind: 'delegated-state' }>;
}) {
  return (
    <p
      className={`px-2 py-1 text-xs ${row.isError ? 'text-destructive' : 'text-muted-foreground'}`}
      role={row.isError ? 'alert' : 'status'}
    >
      {row.label}
    </p>
  );
}
