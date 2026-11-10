import { Button, Checkbox, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { ChevronDown, ShieldQuestion } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import type { WorkspaceBarTrust, WorkspaceBarTrustAsk } from './workspace-bar';

/**
 * The offer to make the folder's parent a trusted location: unticked until the
 * person ticks it, and it names the folder everything in which would be trusted.
 */
const ParentLocationOffer = ({
  checked,
  disabled,
  location,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly location: string;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement => {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-xs">
      <Checkbox
        aria-describedby={`${id}-cost`}
        checked={checked}
        className="mt-0.5"
        disabled={disabled}
        id={id}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <div className="min-w-0 space-y-0.5">
        <label className="[overflow-wrap:anywhere]" htmlFor={id}>
          Also trust every folder in <span className="font-medium">{location}</span>
        </label>
        <p className="text-muted-foreground" id={`${id}-cost`}>
          A folder put there later is trusted without asking, so tick this only where you keep your
          own work.
        </p>
      </div>
    </div>
  );
};

/** One question: the folder the answer is for, what it holds back, and the two answers. */
const TrustAsk = ({
  ask,
  busy,
  onDecide,
}: {
  readonly ask: WorkspaceBarTrustAsk;
  readonly busy: boolean;
  readonly onDecide: WorkspaceBarTrust['onDecide'];
}): ReactElement => {
  const [alsoParent, setAlsoParent] = useState(false);
  const { offeredLocation } = ask;
  return (
    <section
      className="space-y-2"
      data-testid={`workspace-bar-trust-ask-${ask.folders[0]?.rootId}`}
    >
      <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">
        Trust the files in {ask.displayName}?
      </h2>
      <ul className="space-y-0.5 text-xs [overflow-wrap:anywhere]">
        {ask.folders.map((folder) => (
          <li key={folder.rootId}>
            {ask.sharedWithWorktrees ? (
              <span className="font-medium">{folder.displayName}: </span>
            ) : null}
            {folder.holds}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground text-xs">
        These can steer the assistant, so Brainstrike holds them until you trust the folder. The
        assistant works without them until then.
        {ask.sharedWithWorktrees ? ' Your answer covers this repository and its worktrees.' : null}
      </p>
      {offeredLocation ? (
        <ParentLocationOffer
          checked={alsoParent}
          disabled={busy}
          location={offeredLocation}
          onCheckedChange={setAlsoParent}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          // The parent is trusted only with the folder, and only when its box is ticked.
          onClick={() =>
            offeredLocation && alsoParent
              ? onDecide(ask, 'trusted', offeredLocation)
              : onDecide(ask, 'trusted')
          }
          size="sm"
        >
          Trust folder
        </Button>
        <Button
          disabled={busy}
          onClick={() => onDecide(ask, 'restricted')}
          size="sm"
          variant="outline"
        >
          Keep restricted
        </Button>
      </div>
    </section>
  );
};

/**
 * ADR-0032: the thread's folders whose instructions, skills, slash commands
 * and subagents are held until the person answers. The chip counts them;
 * opening it asks once per answer. Nothing waits on it: a run sent before an
 * answer leaves them out. A trust read that failed is shown here too, since it
 * would otherwise hide every question.
 */
export const TrustChip = ({ trust }: { readonly trust: WorkspaceBarTrust }): ReactElement => {
  const [open, setOpen] = useState(false);
  const held = trust.asks.reduce((total, ask) => total + ask.held, 0);
  const label = trust.asks.length > 0 ? `${held} held` : 'not checked';

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Workspace trust: ${label}`}
          className="bs-composer-chip bs-composer-chip-count"
          data-testid="workspace-bar-trust-chip"
          type="button"
        >
          <ShieldQuestion aria-hidden="true" className="text-warning" />
          <span className="bs-composer-chip-label">{label}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Workspace trust"
        className="max-h-(--radix-popover-content-available-height) w-[min(24rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-xl p-3"
        collisionPadding={16}
        data-testid="workspace-bar-trust-menu"
        // The chip leaves with its last answer; without its anchor the popover
        // would paint at the window's corner while it closes, so it hides.
        hideWhenDetached={!open}
        side="top"
      >
        {trust.asks.map((ask) => (
          <TrustAsk
            ask={ask}
            busy={trust.busyPath === ask.path}
            key={ask.path}
            onDecide={trust.onDecide}
          />
        ))}
        {trust.onRetry ? (
          <div className="space-y-2" role="alert">
            <p className="text-destructive text-xs">
              Brainstrike couldn’t check whether this thread’s folders hold instructions or skills
              that need your answer. Folders you already trusted are unaffected.
            </p>
            <Button onClick={trust.onRetry} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {trust.actionError ? (
          <p className="text-destructive text-xs" role="alert">
            {trust.actionError}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};

TrustChip.displayName = 'TrustChip';
