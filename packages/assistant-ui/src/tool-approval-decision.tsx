import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  isApprovalTargetRoot,
  isCodeExecutionApprovalContext,
} from '@brainstrike/assistant-contract/tool-approval';
import { Button } from '@brainstrike/ui';
import { type ComponentProps, type ReactElement, type Ref, useState } from 'react';
import { ApprovalPreview } from './approval-preview';
import type { ApprovalPreviewSubject } from './approval-preview-policy';
import { approvalDecisions, describableApprovalOptions } from './committed-approval-options';

type ToolProps = ComponentProps<ToolCallMessagePartComponent>;

/**
 * The waiting approval's preview subject, with its host facts when they are
 * valid. The approval's id is the host's interaction id.
 */
function previewSubject(tool: ToolProps, interactionId: string): ApprovalPreviewSubject {
  const context: unknown = tool.providerMetadata?.['brainstrike']?.['executionContext'];
  const targetRoot: unknown = tool.providerMetadata?.['brainstrike']?.['targetRoot'];
  const sandboxed: unknown = tool.providerMetadata?.['brainstrike']?.['sandboxed'];
  return {
    args: tool.args,
    interactionId,
    toolName: tool.toolName,
    ...(isCodeExecutionApprovalContext(context) ? { executionContext: context } : {}),
    ...(typeof sandboxed === 'boolean' ? { sandboxed } : {}),
    ...(isApprovalTargetRoot(targetRoot) ? { targetRoot } : {}),
  };
}

/**
 * A pending approval decision: what the call will do (the shared approval
 * preview, as the legacy card shows it), then its answers. A code-execution
 * call the preview cannot describe offers no grant, only Approve / Decline.
 */
export function ToolApprovalDecision({
  decisionRef,
  tool,
}: {
  readonly decisionRef: Ref<HTMLFieldSetElement>;
  readonly tool: ToolProps;
}): ReactElement | null {
  const [responding, setResponding] = useState(false);
  const [approvalError, setApprovalError] = useState<string>();
  const approval = tool.approval;
  if (
    !approval ||
    approval.approved !== undefined ||
    approval.resolution !== undefined ||
    (approval.display ?? 'decision') !== 'decision' ||
    approval.allowFreeform
  ) {
    return null;
  }
  const subject = previewSubject(tool, approval.id);
  const options = describableApprovalOptions(approval.options, subject);
  const reviewNote: unknown = tool.providerMetadata?.['brainstrike']?.['reviewNote'];
  return (
    <fieldset
      aria-label={`Tool approval ${tool.toolName}`}
      className="flex flex-col gap-2 px-3 pb-3"
      ref={decisionRef}
    >
      {typeof reviewNote === 'string' ? (
        <p className="text-muted-foreground text-xs" data-testid="approval-review-note">
          {reviewNote}
        </p>
      ) : null}
      <ApprovalPreview approval={subject} />
      <div className="flex flex-wrap gap-2">
        {approvalDecisions(options).map(({ approved, label, optionId }) => (
          <Button
            aria-disabled={responding || undefined}
            aria-label={`${label} ${tool.toolName}`}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            key={optionId ?? String(approved)}
            // aria-disabled, not `disabled`: a disabled button drops the
            // keyboard focus it holds. While the decision is pending the
            // pressed control keeps focus and the guard refuses a repeat.
            onClick={() => {
              if (responding) {
                return;
              }
              setResponding(true);
              setApprovalError(undefined);
              // The public runtime routes the exact committed interaction.
              // Only the host's publication resolves or removes this card.
              void tool
                .respondToApproval(optionId === undefined ? { approved } : { approved, optionId })
                .catch((cause: unknown) => {
                  setApprovalError(cause instanceof Error ? cause.message : String(cause));
                  setResponding(false);
                });
            }}
            variant={optionId === undefined && approved ? 'default' : 'outline'}
          >
            {label}
          </Button>
        ))}
      </div>
      {approvalError === undefined ? null : <p role="alert">{approvalError}</p>}
    </fieldset>
  );
}
