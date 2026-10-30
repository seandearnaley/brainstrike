import type { ReactElement, ReactNode } from 'react';

/**
 * The thread's body: its messages above the composer, or, for a new thread
 * that has no messages yet, a centred welcome with the same composer beneath
 * it on a soft gradient.
 */
export function ThreadBody({
  children: composer,
  disabledReason,
  messages,
  welcome,
}: {
  readonly children: ReactNode;
  readonly disabledReason: string | undefined;
  readonly messages: ReactNode;
  readonly welcome: boolean;
}): ReactElement {
  if (!welcome) {
    return (
      <>
        {messages}
        {composer}
      </>
    );
  }
  return (
    <div
      className="bs-new-thread relative isolate flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="new-thread-welcome"
    >
      <div
        aria-hidden="true"
        className="from-primary/15 dark:from-primary/25 pointer-events-none absolute inset-0 -z-10 bg-radial-[ellipse_70%_55%_at_50%_68%] to-transparent to-70% forced-colors:hidden"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-radial-[ellipse_45%_35%_at_50%_0%] from-(--chart-2)/12 to-transparent to-70% forced-colors:hidden"
      />
      <div className="flex flex-[1_1_0] flex-col items-center justify-end gap-2 px-6 pt-10 pb-5 text-center motion-safe:animate-[bs-new-thread-rise_320ms_ease-out]">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">What’s on your mind?</h2>
        <p className="text-muted-foreground text-sm">
          The thread is saved when you send your first message.
        </p>
        {disabledReason ? (
          <p aria-live="polite" className="text-muted-foreground max-w-prose text-xs">
            {disabledReason}
          </p>
        ) : null}
      </div>
      {composer}
      <div aria-hidden="true" className="flex-[1.2_1_0]" />
    </div>
  );
}
