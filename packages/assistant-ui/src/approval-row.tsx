import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { ChevronRight } from 'lucide-react';
import { type CSSProperties, useId, useState } from 'react';
import { type ActivityVerb, verbForTool } from './activity-verbs';
import { agentColorStyle } from './agent-color-style';
import { ApprovalCard } from './approval-card';
import { describeDelegationChain } from './approval-notice-status';
import { approvalDepth } from './approval-presentation';
import { RediscoveredPauseLines } from './rediscovered-pause-lines';
import { extractPrimaryArg } from './tool-summaries';
import type { ApprovalNoticeState } from './use-approval-notice-state';

export interface ApprovalRowProps {
  readonly approval: AssistantToolApprovalRequest;
  readonly colorId?: string | undefined;
  readonly ownerDisplayName?: string | undefined;
  readonly state: ApprovalNoticeState;
}

/**
 * "run skill script" — the action the approval asks for, as the row's verb: the
 * verb's request form, lower-cased. An approval names what was asked; its
 * status chip says what became of it, so a declined call never reads "ran".
 */
function requestedAction(verb: ActivityVerb): string {
  return `${verb.request.charAt(0).toLowerCase()}${verb.request.slice(1)}`;
}

/**
 * The collapsed approval: rail(s) · persona · requested action · target ·
 * status chip · chevron, ≈ 28 px tall. Expanding it mounts the full card
 * (`ApprovalCard`, `presentation="embedded"`): locked for an answered
 * approval, actionable for a pending one waiting behind its category's card.
 * A durable decision state's recovery status renders UNDER the collapsed
 * line: it is safety information ("Processing stopped and the outcome is
 * unknown…") and must be readable without opening the row, so the row owns
 * it and the embedded card omits it.
 * Carries the shared notice test id so the live verifier and the reload e2e
 * keep counting every pause.
 */
export function ApprovalRow({ approval, colorId, ownerDisplayName, state }: ApprovalRowProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const delegation = approval.delegation;
  // A named owner wins: a host child's history names its call sign without a legacy delegation identity.
  const owner =
    ownerDisplayName ?? (delegation ? describeDelegationChain(delegation) : 'Assistant');
  const verb = verbForTool(approval.toolName, approval.args);
  const action = requestedAction(verb);
  const target = verb.namesTool
    ? undefined
    : extractPrimaryArg(approval.args, undefined, verb.targetArg);
  const visible = target ? `${owner} ${action} ${target.display}` : `${owner} ${action}`;
  const affordance = expanded ? 'hide approval details' : 'show approval details';
  const style = {
    ...agentColorStyle(colorId),
    '--bs-approval-depth': approvalDepth(approval),
  } as CSSProperties;
  // The row renders a durable decision's recovery status itself, so the
  // embedded card receives a state without that display and never renders it
  // a second time. Pending-since and stale lines still reach the card.
  const embeddedState: ApprovalNoticeState =
    state.rediscovered?.decisionState === undefined ? state : { ...state, rediscovered: null };

  return (
    <div
      className="bs-approval bs-approval-row"
      data-agent-color={colorId}
      data-approval-presentation="row"
      data-testid="assistant-tool-approval-notice"
      style={style}
    >
      <button
        aria-expanded={expanded}
        aria-label={`${visible}, ${affordance}`}
        className="bs-approval-row-line"
        onClick={() => setExpanded((current) => !current)}
        title={state.delegationOwner ?? approval.toolName}
        type="button"
        {...(expanded ? { 'aria-controls': bodyId } : {})}
      >
        <span className="bs-approval-row-owner" data-testid="approval-delegation-owner">
          {owner}
        </span>
        <span className="bs-approval-row-tool">
          <span className="bs-approval-row-verb">{action}</span>
          {target ? (
            <span className="bs-approval-row-target" title={target.full}>
              {target.display}
            </span>
          ) : null}
        </span>
        <span className="bs-approval-row-status" data-testid="approval-row-status">
          {state.status}
        </span>
        <ChevronRight aria-hidden="true" className="bs-step-row-chevron bs-trace-glyph size-3.5" />
      </button>
      {state.rediscovered?.decisionState === undefined ? null : (
        <div className="bs-approval-row-recovery">
          <RediscoveredPauseLines display={state.rediscovered} />
        </div>
      )}
      {expanded ? (
        <div className="bs-approval-row-body" id={bodyId}>
          <ApprovalCard approval={approval} presentation="embedded" state={embeddedState} />
        </div>
      ) : null}
    </div>
  );
}
