import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { ChevronRight } from 'lucide-react';
import { type CSSProperties, useId, useState } from 'react';
import { verbForTool } from './activity-verbs';
import { ApprovalCard } from './approval-card';
import { describeDelegationChain } from './approval-notice-status';
import { approvalDepth } from './approval-presentation';
import { ApprovalRails } from './approval-rails';
import { delegationColourIndex } from './delegation-colour';
import { RediscoveredPauseLines } from './rediscovered-pause-lines';
import { extractPrimaryArg } from './tool-summaries';
import type { ApprovalNoticeState } from './use-approval-notice-state';

export interface ApprovalRowProps {
  readonly approval: AssistantToolApprovalRequest;
  readonly state: ApprovalNoticeState;
}

/** "read" — the requested action as the row's verb (lower-cased `done` form). */
function requestedAction(toolName: string): string {
  const verb = verbForTool(toolName);
  return `${verb.done.charAt(0).toLowerCase()}${verb.done.slice(1)}`;
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
export function ApprovalRow({ approval, state }: ApprovalRowProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const delegation = approval.delegation;
  const leaf = delegation?.path.at(-1);
  const owner = delegation ? describeDelegationChain(delegation) : 'Assistant';
  const verb = verbForTool(approval.toolName);
  const action = requestedAction(approval.toolName);
  const target = verb.namesTool ? undefined : extractPrimaryArg(approval.args, undefined);
  const visible = target ? `${owner} ${action} ${target.display}` : `${owner} ${action}`;
  const affordance = expanded ? 'hide approval details' : 'show approval details';
  const style = { '--bs-approval-depth': approvalDepth(approval) } as CSSProperties;
  // The row renders a durable decision's recovery status itself, so the
  // embedded card receives a state without that display and never renders it
  // a second time. Pending-since and stale lines still reach the card.
  const embeddedState: ApprovalNoticeState =
    state.rediscovered?.decisionState === undefined ? state : { ...state, rediscovered: null };

  return (
    <div
      className="bs-approval bs-approval-row"
      data-approval-presentation="row"
      data-testid="assistant-tool-approval-notice"
      style={style}
      {...(leaf ? { 'data-delegation-colour': delegationColourIndex(leaf.parentToolCallId) } : {})}
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
        <ApprovalRails path={delegation?.path ?? []} />
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
