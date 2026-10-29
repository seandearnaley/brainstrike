import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { Button } from '@brainstrike/ui';
import { Check, CheckCheck, X } from 'lucide-react';
import { type ComponentProps, type ReactElement, type Ref, useState } from 'react';

type ToolProps = ComponentProps<ToolCallMessagePartComponent>;
/** The host's `network` consent answer; `remember` saves it for the origin. */
interface OriginAnswer {
  readonly action: 'allow' | 'deny';
  readonly remember?: true;
}

const DISABLED = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
/** The loopback origins the agent may be allowed to open: a server on this computer. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u;

/**
 * BST-1178: a person answers for each site the agent opens in its own browser
 * tab, by origin, until they save an answer. Don't allow is first, primary and
 * autofocused, and saved, as is Always allow; Allow once opens this call only.
 * Settings → Permissions lists and removes saved answers. Where the policy also
 * asks to approve the call, the answer approves this call; it offers no grant.
 */
export function CommittedOriginConsent({
  decisionRef,
  tool,
}: {
  readonly decisionRef: Ref<HTMLFieldSetElement>;
  readonly tool: ToolProps;
}): ReactElement | null {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const facts = tool.providerMetadata?.['brainstrike'];
  const approval = tool.approval;
  const origin: unknown = facts?.['origin'];
  if (
    !(approval && approval.approved === undefined && approval.resolution === undefined) ||
    facts?.['interactionKind'] !== 'network' ||
    typeof origin !== 'string'
  ) {
    return null;
  }
  const send = (answer: OriginAnswer): void => {
    // The pressed control stays focusable (aria-disabled) while pending; refuse a repeat.
    if (sending) {
      return;
    }
    setSending(true);
    setError(undefined);
    void tool
      .respondToApproval({ approved: answer.action === 'allow', text: JSON.stringify(answer) })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setSending(false);
      });
  };
  return (
    <fieldset
      aria-label={`Open ${origin}`}
      className="flex flex-col gap-2 px-3 pb-3"
      data-testid="committed-origin-consent"
      ref={decisionRef}
    >
      <legend className="text-xs font-medium">The agent wants to open this site</legend>
      <p className="font-mono text-xs break-all" data-testid="committed-origin-consent-origin">
        {origin}
      </p>
      {LOCAL_ORIGIN.test(origin) ? (
        <p className="text-muted-foreground text-xs" data-testid="committed-origin-consent-local">
          A server on this computer, such as a dev server. Only this port opens.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {/* Deny is FIRST in DOM and tab order, primary, and autofocused. */}
        <Button
          aria-disabled={sending || undefined}
          autoFocus
          className={DISABLED}
          data-testid="origin-consent-deny"
          onClick={() => send({ action: 'deny', remember: true })}
          size="sm"
        >
          <X className="size-3.5" />
          Don't allow
        </Button>
        <Button
          aria-disabled={sending || undefined}
          className={DISABLED}
          data-testid="origin-consent-allow-once"
          onClick={() => send({ action: 'allow' })}
          size="sm"
          variant="outline"
        >
          <Check className="size-3.5" />
          Allow once
        </Button>
        <Button
          aria-disabled={sending || undefined}
          className={DISABLED}
          data-testid="origin-consent-allow-always"
          onClick={() => send({ action: 'allow', remember: true })}
          size="sm"
          variant="outline"
        >
          <CheckCheck className="size-3.5" />
          Always allow
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        Don't allow and Always allow are remembered for this site; remove them in Settings →
        Permissions. A page it opens can still load, or redirect to, other sites.
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </fieldset>
  );
}
