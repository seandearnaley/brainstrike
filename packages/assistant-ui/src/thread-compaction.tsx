/**
 * BST-2536: Compact now, in the context meter's popover. A person compacts the
 * thread between runs and may write what to keep. The thread's owner (the
 * desktop's host thread) supplies the command; without one, none is offered.
 */
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import { Button, Input } from '@brainstrike/ui';
import { type ReactElement, type ReactNode, use, useState } from 'react';
import type {
  CommittedAssistantSnapshot,
  CommittedAssistantStore,
} from './committed-assistant-store';
import {
  type ThreadCompaction,
  ThreadCompactionContext,
  type ThreadCompactionValue,
} from './thread-compaction-context';
import { useCommittedAssistantSelector } from './use-committed-assistant-runtime';

/**
 * The longest focus the host takes, in code points (`COMPACTION_FOCUS_MAX_CODE_POINTS`); the
 * field's `maxLength` counts UTF-16 units, so it never lets more through.
 */
const FOCUS_MAX = 500;

/** The owner's compaction for the meter and composer below; the store says where the view ends. */
export function ThreadCompactionProvider({
  children,
  compact,
  store,
}: {
  readonly children: ReactNode;
  readonly compact: ThreadCompaction | undefined;
  readonly store: CommittedAssistantStore;
}): ReactElement {
  const [focus, setFocus] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const start = async (parentMessageId: string | null): Promise<void> => {
    if (!compact) {
      return;
    }
    const kept = focus.trim();
    setCompacting(true);
    setFailure(null);
    try {
      await compact({ ...(kept ? { focus: kept } : {}), parentMessageId });
      setFocus('');
    } catch (cause) {
      setFailure(describeBoundaryError(cause));
    } finally {
      setCompacting(false);
    }
  };
  return (
    <ThreadCompactionContext
      value={compact ? { compacting, failure, focus, setFocus, start, store } : null}
    >
      {children}
    </ThreadCompactionContext>
  );
}

const selectHead = (snapshot: CommittedAssistantSnapshot): string | null =>
  snapshot.repository.headId ?? null;

const selectRunning = (snapshot: CommittedAssistantSnapshot): boolean => snapshot.isRunning;

/**
 * A message follows the view's head: a rewind moved it back. The thread
 * compacts once its next message is sent (`compaction.rewound`).
 */
const selectRewound = (snapshot: CommittedAssistantSnapshot): boolean => {
  const head = snapshot.repository.headId ?? null;
  return snapshot.repository.messages.some((row) => row.parentId === head);
};

function CompactNow({ value }: { readonly value: ThreadCompactionValue }): ReactElement {
  const head = useCommittedAssistantSelector(value.store, selectHead);
  const running = useCommittedAssistantSelector(value.store, selectRunning);
  const rewound = useCommittedAssistantSelector(value.store, selectRewound);
  const { compacting, failure, focus, setFocus, start } = value;
  const disabled = compacting || running || rewound || head === null;
  return (
    <>
      <div aria-hidden="true" className="border-border/60 my-1 border-t" />
      <form
        className="flex items-center gap-2"
        data-testid="context-usage-compact"
        onSubmit={(event) => {
          event.preventDefault();
          void start(head);
        }}
      >
        <Input
          aria-label="What to keep"
          className="h-7 min-w-0 flex-1 text-xs"
          disabled={disabled}
          maxLength={FOCUS_MAX}
          onChange={(event) => setFocus(event.target.value)}
          placeholder="What to keep"
          value={focus}
        />
        <Button
          className="h-7 shrink-0 px-2 text-xs"
          disabled={disabled}
          size="sm"
          type="submit"
          variant="outline"
        >
          {compacting ? 'Compacting…' : 'Compact now'}
        </Button>
      </form>
      {failure === null ? null : (
        <p className="text-destructive text-2xs mt-1 break-words" role="alert">
          {failure}
        </p>
      )}
    </>
  );
}

/** The popover's Compact now row, where the thread's owner offers it. */
export function CompactNowControl(): ReactElement | null {
  const value = use(ThreadCompactionContext);
  return value ? <CompactNow value={value} /> : null;
}
