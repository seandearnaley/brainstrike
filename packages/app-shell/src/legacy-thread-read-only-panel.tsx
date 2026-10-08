import {
  createPgliteAssistantThreadRepository,
  type LegacyThreadReadOnlyHistory,
  loadLegacyThreadReadOnly,
} from '@brainstrike/assistant-data';
import { ReadOnlyAssistantConversation } from '@brainstrike/assistant-ui';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { type ReactElement, useEffect, useState } from 'react';

/** The settled load for one thread; any other thread is still loading. */
type LoadResult =
  | { readonly key: string; readonly kind: 'error'; readonly message: string }
  | { readonly key: string; readonly kind: 'ready'; readonly value: LegacyThreadReadOnlyHistory };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the conversion cannot show, stated from this thread's own data. */
export function describeLegacyConversionLosses(value: LegacyThreadReadOnlyHistory): string[] {
  const losses: string[] = [];
  if (value.interruptedDecisions > 0) {
    losses.push(
      `${plural(value.interruptedDecisions, 'pending decision was', 'pending decisions were')} interrupted by the upgrade and can no longer be answered.`
    );
  }
  if (value.otherBranchMessages > 0) {
    losses.push(
      `${plural(value.otherBranchMessages, 'message', 'messages')} on other branches ${value.otherBranchMessages === 1 ? 'is' : 'are'} not shown.`
    );
  }
  return losses;
}

function LegacyConversionNotice({
  value,
}: {
  readonly value: LegacyThreadReadOnlyHistory;
}): ReactElement {
  const losses = describeLegacyConversionLosses(value);
  return (
    <div
      aria-label="Read-only conversation"
      className="shrink-0 border-b px-3 py-2 text-muted-foreground text-xs"
      role="note"
    >
      <p>
        This conversation was started before the agent host. It is read-only: start a new thread to
        continue.
      </p>
      {losses.length === 0 ? (
        <p>Nothing in its history was lost in conversion.</p>
      ) : (
        <ul className="list-disc pl-4">
          {losses.map((loss) => (
            <li key={loss}>{loss}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A legacy (pre-host) thread, converted and shown read-only. It never writes. */
export function LegacyThreadReadOnlyPanel({
  resourceId,
  threadId,
}: {
  readonly resourceId: string;
  readonly threadId: string;
}): ReactElement {
  const database = usePGliteDatabase();
  const key = `${resourceId}\n${threadId}`;
  const [result, setResult] = useState<LoadResult>();
  useEffect(() => {
    if (!database) {
      return;
    }
    let current = true;
    loadLegacyThreadReadOnly(
      createPgliteAssistantThreadRepository(database),
      threadId,
      resourceId
    ).then(
      (value) => {
        if (current) {
          setResult({ key, kind: 'ready', value });
        }
      },
      (cause: unknown) => {
        if (current) {
          setResult({
            key,
            kind: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [database, key, resourceId, threadId]);
  const state = result?.key === key ? result : undefined;
  if (!state) {
    return <div role="status">Loading conversation…</div>;
  }
  if (state.kind === 'error') {
    return <div role="alert">{state.message}</div>;
  }
  return (
    <ReadOnlyAssistantConversation
      history={state.value.history}
      label="Assistant"
      notice={<LegacyConversionNotice value={state.value} />}
      threadKey={threadId}
    />
  );
}
