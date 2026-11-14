/**
 * BST-2536: Compact now, in the context meter's popover. A person compacts the
 * thread between runs and may write what to keep. The thread's owner (the
 * desktop's host thread) supplies the command; without one, none is offered.
 */
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import { Button, Input } from '@brainstrike/ui';
import { createContext, type ReactElement, type ReactNode, use, useState } from 'react';
import type {
  CommittedAssistantSnapshot,
  CommittedAssistantStore,
} from './committed-assistant-store';
import { useCommittedAssistantSelector } from './use-committed-assistant-runtime';

/**
 * The longest focus the host takes, in code points (`COMPACTION_FOCUS_MAX_CODE_POINTS`); the
 * field's `maxLength` counts UTF-16 units, so it never lets more through.
 */
const FOCUS_MAX = 500;

/**
 * Compacts the thread's branch that ends with `parentMessageId`, the run the
 * view ends with; rejects with the host's refusal.
 */
export type ThreadCompaction = (request: {
  readonly focus?: string;
  readonly parentMessageId: string | null;
}) => Promise<void>;

interface ThreadCompactionValue {
  readonly compact: ThreadCompaction;
  readonly store: CommittedAssistantStore;
}

const ThreadCompactionContext = createContext<ThreadCompactionValue | null>(null);

/** The owner's compaction for the meter below; the committed store says where the view ends. */
export function ThreadCompactionProvider({
  children,
  compact,
  store,
}: {
  readonly children: ReactNode;
  readonly compact: ThreadCompaction | undefined;
  readonly store: CommittedAssistantStore;
}): ReactElement {
  return (
    <ThreadCompactionContext value={compact ? { compact, store } : null}>
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
  const [focus, setFocus] = useState('');
  const [compacting, setCompacting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const disabled = compacting || running || rewound || head === null;
  const submit = async (): Promise<void> => {
    const kept = focus.trim();
    setCompacting(true);
    setFailure(null);
    try {
      await value.compact({ ...(kept ? { focus: kept } : {}), parentMessageId: head });
      setFocus('');
    } catch (cause) {
      setFailure(describeBoundaryError(cause));
    } finally {
      setCompacting(false);
    }
  };
  return (
    <>
      <div aria-hidden="true" className="border-border/60 my-1 border-t" />
      <form
        className="flex items-center gap-2"
        data-testid="context-usage-compact"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
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
