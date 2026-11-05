import { Button } from '@brainstrike/ui';
import type { ReactElement, ReactNode } from 'react';

/**
 * The step that clears a disabled reason (e.g. "Connect a provider" opening
 * Settings → Providers). Offered only where the host can take the user there;
 * without it the reason shows as text alone.
 */
export interface ComposerDisabledAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * The thread's body: its messages above the composer, or, for a new thread
 * that has no messages yet, a centred welcome with the same composer beneath
 * it on a soft gradient. On the welcome, a disabled reason carries its fix as
 * the one primary action.
 */
export function ThreadBody({
  children: composer,
  disabledAction,
  disabledReason,
  messages,
  welcome,
}: {
  readonly children: ReactNode;
  readonly disabledAction?: ComposerDisabledAction | undefined;
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
          <WelcomeDisabledReason action={disabledAction} reason={disabledReason} />
        ) : null}
      </div>
      {composer}
      <div aria-hidden="true" className="flex-[1.2_1_0]" />
    </div>
  );
}

const WelcomeDisabledReason = ({
  action,
  reason,
}: {
  readonly action: ComposerDisabledAction | undefined;
  readonly reason: string;
}) => (
  <div className="flex flex-col items-center gap-3" data-testid="new-thread-disabled-reason">
    <p
      aria-live="polite"
      className={action ? 'max-w-prose text-sm' : 'text-muted-foreground max-w-prose text-xs'}
    >
      {reason}
    </p>
    {action ? (
      <Button onClick={action.onSelect} size="sm" type="button">
        {action.label}
      </Button>
    ) : null}
  </div>
);
