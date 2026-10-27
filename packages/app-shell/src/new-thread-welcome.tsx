import { describeBoundaryError } from '@brainstrike/assistant-contract/boundary-failure';
import {
  type AssistantThreadCatalogRepository,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import { Button, cn, toast } from '@brainstrike/ui';
import { ArrowUp, Folder } from 'lucide-react';
import type { FormEvent, KeyboardEvent, ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';

export interface NewThreadWelcomeProps {
  readonly repository: AssistantThreadCatalogRepository;
  readonly resourceId: string;
}

/**
 * The new-thread screen: a centred composer and no thread behind it. The
 * first send creates the thread, binds it to the folder it was started from
 * (one metadata write carrying the whole binding), and hands the message to
 * the thread's own composer, which sends it through the same path as every
 * later message. A new thread that is never sent leaves nothing behind.
 */
export function NewThreadWelcome({ repository, resourceId }: NewThreadWelcomeProps): ReactElement {
  const createThread = useAssistantThreadStore((state) => state.createThread);
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const folder = useAssistantThreadStore((state) => state.newThreadFolderByResourceId[resourceId]);
  const catalogBusy = useAssistantThreadStore(
    (state) => state.loadStateByResourceId[resourceId]?.status === 'loading'
  );
  const [text, setText] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const hintId = useId();
  const canSend = text.trim().length > 0 && !(starting || catalogBusy);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const start = async (): Promise<void> => {
    const message = text;
    setStarting(true);
    setError(null);
    let threadId: string;
    try {
      // Opens the thread's tab, which replaces this screen.
      threadId = (await createThread(repository, resourceId)).id;
    } catch (cause: unknown) {
      setStarting(false);
      setError(describeBoundaryError(cause));
      return;
    }
    const handOff = (mode: 'replace' | 'send'): void => {
      useAssistantComposerCommandStore.getState().enqueue({ mode, text: message, threadId });
    };
    if (folder) {
      try {
        await updateThreadMetadata(repository, resourceId, threadId, {
          operatingRootDisplayName: folder.displayName,
          operatingRootId: folder.rootId,
          ...(folder.path ? { operatingRootPath: folder.path } : {}),
        });
      } catch (cause: unknown) {
        // Unsent, rather than started in a folder the person did not pick.
        handOff('replace');
        toast({
          description: `Could not bind it to ${folder.displayName}. Select ${folder.displayName} in the thread, then send your message. Error: ${describeBoundaryError(cause)}`,
          title: 'Thread created in No folder',
          variant: 'destructive',
        });
        return;
      }
    }
    handOff('send');
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSend) {
      void start();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    // The same landmark as a thread's conversation: the Assistant, before its first message.
    <section
      aria-label="Assistant"
      className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-background px-4 py-8"
      data-testid="new-thread-welcome"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-radial-[ellipse_70%_55%_at_50%_68%] from-primary/20 to-70% to-transparent dark:from-primary/30 forced-colors:hidden"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-radial-[ellipse_45%_35%_at_50%_0%] from-[hsl(var(--chart-2)/0.12)] to-70% to-transparent forced-colors:hidden"
      />
      <form
        aria-label="New thread"
        className="relative flex w-full max-w-2xl flex-col items-center gap-6 motion-safe:animate-[welcome-rise_320ms_ease-out]"
        onSubmit={submit}
      >
        <h2 className="text-balance text-center font-light text-3xl text-foreground tracking-tight">
          What&rsquo;s on your mind?
        </h2>
        <div
          className={cn(
            'w-full rounded-3xl border border-border/70 bg-card/85 shadow-black/5 shadow-xl backdrop-blur-md transition-[border-color,box-shadow]',
            'focus-within:border-ring/60 focus-within:shadow-primary/10 dark:shadow-black/40'
          )}
        >
          {/* The same names as the thread's own composer: it is the same control. */}
          <label className="sr-only" htmlFor={inputId}>
            Message input
          </label>
          <textarea
            aria-describedby={hintId}
            className="field-sizing-content block max-h-64 min-h-14 w-full resize-none bg-transparent px-5 pt-4 pb-1 text-base text-foreground leading-relaxed outline-none placeholder:text-muted-foreground"
            data-testid="new-thread-input"
            id={inputId}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask anything, or describe a task"
            readOnly={starting}
            ref={inputRef}
            rows={1}
            value={text}
          />
          <div className="flex items-center gap-2 px-3 pb-3">
            {folder ? (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-muted-foreground text-xs"
                data-testid="new-thread-folder"
                title={folder.path ?? folder.displayName}
              >
                <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="truncate">{folder.displayName}</span>
              </span>
            ) : null}
            <Button
              aria-label="Send"
              className="ml-auto size-9 rounded-full"
              data-testid="new-thread-send"
              disabled={!canSend}
              size="icon"
              type="submit"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
        <p className="text-center text-muted-foreground text-xs" id={hintId}>
          The thread is saved when you send your first message.
        </p>
        {error ? (
          <p className="text-center text-destructive text-sm" role="alert">
            Could not start the thread: {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
