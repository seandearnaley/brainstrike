import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { isCodeExecutionApprovalContext } from '@brainstrike/assistant-contract/tool-approval';
import { Button } from '@brainstrike/ui';
import { Check, X } from 'lucide-react';
import { type ComponentProps, type ReactElement, type Ref, useState } from 'react';
import { ApprovalPreview } from './approval-preview';
import {
  type ApprovalPreviewSubject,
  resolveApprovalPreviewPolicy,
} from './approval-preview-policy';
import { NetworkDomainChecklist, tickDomain } from './network-domain-checklist';
import { GRANT_OPTION_KINDS } from './tool-approval-decision';

type ToolProps = ComponentProps<ToolCallMessagePartComponent>;

/**
 * run_python's network consent on a host thread. Legacy asked twice under an
 * `ask` policy (the run approval, then the network escalation); the host's SDK
 * gives a call one approval round, so this one card asks both. It shows what
 * the code can touch and the domains it asks for, each ticked by hand. Don't
 * allow is first, primary and autofocused, as on the legacy escalation. Grants
 * appear only when the policy also asked to approve the run, and they remember
 * that approval, never the network: every networked call asks again.
 */
export function CommittedNetworkConsent({
  decisionRef,
  tool,
}: {
  readonly decisionRef: Ref<HTMLFieldSetElement>;
  readonly tool: ToolProps;
}): ReactElement | null {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const facts = tool.providerMetadata?.['brainstrike'];
  const approval = tool.approval;
  if (
    !(approval && approval.approved === undefined && approval.resolution === undefined) ||
    facts?.['interactionKind'] !== 'network'
  ) {
    return null;
  }
  const context: unknown = facts['executionContext'];
  const subject: ApprovalPreviewSubject = {
    args: tool.args,
    toolName: tool.toolName,
    ...(isCodeExecutionApprovalContext(context) ? { executionContext: context } : {}),
  };
  const domains = [...new Set(subject.executionContext?.allowedDomains)];
  const grants =
    resolveApprovalPreviewPolicy(subject)?.suppressGrants === true
      ? []
      : (approval.options ?? []).filter((option) => GRANT_OPTION_KINDS.has(option.kind));
  const allTicked = domains.length > 0 && domains.every((domain) => ticked.has(domain));
  const send = (action: 'allow' | 'deny', optionId?: string): void => {
    // The pressed control stays focusable (aria-disabled) while pending; refuse a repeat.
    if (sending) {
      return;
    }
    setSending(true);
    setError(undefined);
    void tool
      .respondToApproval({
        approved: action === 'allow',
        ...(optionId === undefined ? {} : { optionId }),
        text: JSON.stringify({ action }),
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setSending(false);
      });
  };
  const allowDisabled = sending || !allTicked;
  return (
    <fieldset
      aria-label={`Internet access for ${tool.toolName}`}
      className="flex flex-col gap-2 px-3 pb-3"
      data-testid="committed-network-consent"
      ref={decisionRef}
    >
      <legend className="font-medium text-xs">This script wants to reach the internet</legend>
      <ApprovalPreview approval={subject} networkAskedHere />
      {domains.length === 0 ? (
        <p className="text-muted-foreground text-xs" data-testid="run-python-network-unreadable">
          The request didn't say which domains it needs, so it can't be allowed.
        </p>
      ) : (
        <NetworkDomainChecklist
          disabled={sending}
          domains={domains}
          onTick={(domain, checked) => setTicked((current) => tickDomain(current, domain, checked))}
          ticked={ticked}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {/* Deny is FIRST in DOM and tab order, primary, and autofocused. */}
        <Button
          aria-disabled={sending || undefined}
          autoFocus
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          data-testid="run-python-network-deny"
          onClick={() => send('deny')}
          size="sm"
        >
          <X className="size-3.5" />
          Don't allow
        </Button>
        {domains.length === 0 ? null : (
          <Button
            aria-disabled={allowDisabled || undefined}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            data-testid="run-python-network-allow"
            onClick={() => {
              if (!allowDisabled) {
                send('allow');
              }
            }}
            size="sm"
            variant="outline"
          >
            <Check className="size-3.5" />
            {domains.length === 1 ? `Allow ${domains[0]}` : `Allow these ${domains.length} domains`}
          </Button>
        )}
        {allTicked || sending || domains.length === 0 ? null : (
          <span className="text-muted-foreground text-xs">
            Tick each domain above to enable this.
          </span>
        )}
      </div>
      {grants.length === 0 || domains.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Allow it, and also:</span>
          {grants.map((option) => (
            <Button
              aria-disabled={allowDisabled || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              data-testid={`run-python-network-${option.id}`}
              key={option.id}
              onClick={() => {
                if (!allowDisabled) {
                  send('allow', option.id);
                }
              }}
              size="sm"
              variant="outline"
            >
              {option.label ?? option.id}
            </Button>
          ))}
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        You'll be asked about internet access every time.
        {grants.length === 0
          ? null
          : ' These options remember approving the code, never its internet access.'}
      </p>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </fieldset>
  );
}
