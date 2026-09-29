import { createLogger } from '@brainstrike/logging';
import type { DatabaseIntegrityContext, DatabaseIntegrityState } from '@brainstrike/types';
import { AlertTriangle } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useDatabaseIntegrity } from './use-database-integrity';

const logger = createLogger('DatabaseIntegrityNotice');

interface DatabaseIntegrityNoticeCopy {
  readonly containedMessage: string;
  /** Plain words for a context; an unlisted one is shown as its own identifier. */
  readonly contexts: Partial<Record<DatabaseIntegrityContext, string>>;
  readonly detailsSummary: string;
  readonly fields: {
    readonly code: string;
    readonly message: string;
    readonly since: string;
    readonly where: string;
  };
  /** The only place the repair promise is worded; replaced when automatic repair ships. */
  readonly restartGuidance: string;
  readonly unreadableMessage: string;
}

const COPY: DatabaseIntegrityNoticeCopy = {
  containedMessage:
    'Background indexing is paused because BrainStrike found a problem in its local database. Nothing was deleted or replaced.',
  contexts: {
    'assistant:reindex': 'assistant file re-indexing',
    'db:query': 'a database query',
    'embedding-host:enqueue-backfill': 'embedding indexing',
    maintenance: 'scheduled maintenance',
  },
  detailsSummary: 'Details',
  fields: {
    code: 'Error code (SQLSTATE)',
    message: 'Database message',
    since: 'First seen',
    where: 'Where it happened',
  },
  restartGuidance: 'Restart BrainStrike to resume indexing.',
  unreadableMessage:
    "BrainStrike couldn't read the database status. Restart BrainStrike to check again.",
};

/** A timestamp main sent that does not parse is shown as sent, never as "Invalid Date". */
function formatSince(since: string): string {
  const date = new Date(since);
  return Number.isNaN(date.getTime()) ? since : date.toLocaleString();
}

function UnreadableStrip(): ReactElement {
  return (
    <DatabaseIntegrityStrip>
      <p>{COPY.unreadableMessage}</p>
    </DatabaseIntegrityStrip>
  );
}

/** Same strip as `AppReloadNotice`: a destructive-tinted `role="alert"` row atop the app column. */
function DatabaseIntegrityStrip({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div
      className="flex items-start gap-3 border-destructive/30 border-b bg-destructive/10 px-4 py-2 text-sm"
      data-slot="database-integrity-notice"
      data-testid="database-integrity-notice"
      role="alert"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function DatabaseIntegrityNoticeBody({
  state,
}: {
  readonly state: DatabaseIntegrityState;
}): ReactElement | null {
  switch (state.kind) {
    case 'healthy':
      return null;
    case 'contained':
      return (
        <DatabaseIntegrityStrip>
          <p>{COPY.containedMessage}</p>
          <details className="mt-1 text-xs">
            <summary className="w-fit cursor-pointer select-none rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
              {COPY.detailsSummary}
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{COPY.fields.where}</dt>
              <dd>{COPY.contexts[state.context] ?? state.context}</dd>
              <dt className="text-muted-foreground">{COPY.fields.code}</dt>
              <dd>{state.signal.sqlstate}</dd>
              <dt className="text-muted-foreground">{COPY.fields.message}</dt>
              <dd className="break-words">{state.signal.message}</dd>
              <dt className="text-muted-foreground">{COPY.fields.since}</dt>
              <dd>
                <time dateTime={state.since}>{formatSince(state.since)}</time>
              </dd>
            </dl>
            <p className="mt-2">{COPY.restartGuidance}</p>
          </details>
        </DatabaseIntegrityStrip>
      );
    default: {
      // Compile-time exhaustiveness; at runtime a state this renderer does not know (a newer
      // main, a malformed payload) fails visible, never healthy and never by unmounting the shell.
      const unknown: never = state;
      logger.error('Unknown database integrity state; showing the status as unreadable', {
        kind: (unknown as { readonly kind?: unknown }).kind,
      });
      return <UnreadableStrip />;
    }
  }
}

/**
 * Persistent top strip for the database integrity state. Renders nothing while
 * healthy, while the first read is pending, and where the desktop integrity
 * capability is absent (web). A failed read is shown, never treated as healthy.
 */
export function DatabaseIntegrityNotice(): ReactElement | null {
  const view = useDatabaseIntegrity();
  if (view === null || view.status === 'loading') {
    return null;
  }
  if (view.status === 'unreadable') {
    return <UnreadableStrip />;
  }
  return <DatabaseIntegrityNoticeBody state={view.snapshot.state} />;
}
