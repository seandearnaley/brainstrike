import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { BellRing, Timer, X } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import {
  RISK_CATEGORY_GRANT_NOUN,
  RISK_CATEGORY_GRANT_NOUN_SINGULAR,
} from './approval-notice-status';
import { ApprovalPreview } from './approval-preview';
import type { ApprovalPreviewSubject } from './approval-preview-policy';
import {
  type ApprovalDecision,
  approvalDecisions,
  COMMITTED_SESSION_GRANT_OPTION,
  committedApprovalOptions,
  describableApprovalOptions,
  grantsDescribable,
} from './committed-approval-options';

/** One committed approval still waiting in a host thread or one of its delegated children. */
export interface CommittedPendingApproval {
  readonly args: unknown;
  readonly interactionId: string;
  /** The delegated child that asks, by its call sign; absent for the viewed thread itself. */
  readonly owner?: string;
  /** Answers this approval through its own thread; the host's publication removes it. */
  readonly respond: (response: {
    readonly approved: boolean;
    readonly optionId?: string;
  }) => Promise<void>;
  /** The permission category its session grant names; absent: no category grant. */
  readonly risk?: ToolRiskCategory;
  readonly runId: string;
  /** The folder the host resolved for a file tool's call (BST-1990, D4). */
  readonly targetRoot?: ApprovalPreviewSubject['targetRoot'];
  readonly toolCallId: string;
  readonly toolName: string;
}

function countLabel(category: ToolRiskCategory, count: number): string {
  return `${count} ${count === 1 ? RISK_CATEGORY_GRANT_NOUN_SINGULAR[category] : RISK_CATEGORY_GRANT_NOUN[category]}`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function previewSubject(approval: CommittedPendingApproval): ApprovalPreviewSubject {
  return {
    args: approval.args,
    ...(approval.targetRoot ? { targetRoot: approval.targetRoot } : {}),
    toolName: approval.toolName,
  };
}

/** The approvals of each category, in the order they wait. */
function byCategory(
  approvals: readonly CommittedPendingApproval[]
): ReadonlyMap<ToolRiskCategory, readonly CommittedPendingApproval[]> {
  const categories = new Map<ToolRiskCategory, CommittedPendingApproval[]>();
  for (const approval of approvals) {
    if (approval.risk) {
      categories.set(approval.risk, [...(categories.get(approval.risk) ?? []), approval]);
    }
  }
  return categories;
}

/** One reviewed approval with the decisions its card offers. */
function ReviewedApproval({ approval }: { readonly approval: CommittedPendingApproval }) {
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string>();
  const decide = ({ approved, optionId }: ApprovalDecision): void => {
    if (responding) {
      return;
    }
    setResponding(true);
    setError(undefined);
    approval
      .respond(optionId === undefined ? { approved } : { approved, optionId })
      .catch((cause: unknown) => {
        setError(errorText(cause));
        setResponding(false);
      });
  };
  return (
    <fieldset aria-label={`Approval ${approval.toolName}`} className="flex flex-col gap-2 py-2">
      <div className="flex items-center gap-2 text-sm">
        {approval.owner ? (
          <span className="bs-approval-row-owner" data-testid="approval-delegation-owner">
            {approval.owner}
          </span>
        ) : null}
        <span className="font-medium">{approval.toolName}</span>
      </div>
      <ApprovalPreview approval={previewSubject(approval)} />
      <div className="flex flex-wrap gap-2">
        {approvalDecisions(
          describableApprovalOptions(
            approval.risk ? committedApprovalOptions(approval.risk) : undefined,
            previewSubject(approval)
          )
        ).map((decision) => (
          <Button
            aria-disabled={responding || undefined}
            aria-label={`${decision.label} ${approval.toolName}`}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            key={decision.optionId ?? String(decision.approved)}
            onClick={() => decide(decision)}
            size="sm"
            variant={decision.optionId === undefined && decision.approved ? 'default' : 'outline'}
          >
            {decision.label}
          </Button>
        ))}
      </div>
      {error === undefined ? null : <p role="alert">{error}</p>}
    </fieldset>
  );
}

function CommittedApprovalReview({
  approvals,
  onOpenChange,
  open,
}: {
  readonly approvals: readonly CommittedPendingApproval[];
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const count = approvals.length;
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={
            count === 0
              ? 'Close approval review'
              : `Review ${count} pending ${count === 1 ? 'approval' : 'approvals'}`
          }
          className="gap-2"
          size="sm"
          variant="outline"
        >
          <BellRing aria-hidden="true" className="size-3.5" />
          {count === 0 ? 'Approvals handled' : `Review ${count}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Pending approvals"
        className="max-h-(--radix-popover-content-available-height) w-[min(42rem,calc(100vw-2rem))] overflow-y-auto p-3"
        collisionPadding={16}
        side="top"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-sm">Needs your attention</h2>
            <p className="text-muted-foreground text-xs">Review the action before approving.</p>
          </div>
          <Button
            aria-label="Close pending approvals"
            onClick={() => onOpenChange(false)}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
        {count === 0 ? (
          <p className="p-3 text-muted-foreground text-sm" role="status">
            All approvals handled.
          </p>
        ) : (
          approvals.map((approval) => (
            <ReviewedApproval approval={approval} key={approval.interactionId} />
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * BST-1932: the approvals strip of a host thread at its composer. It counts
 * the approvals waiting in the thread and its delegated children by risk
 * category; one click grants a category for the session and answers the
 * first waiting approval of it whose preview can describe the call, and the
 * host answers the rest of the tree that its policy now allows. Review lists
 * every waiting approval with the decisions its card offers.
 */
export function CommittedApprovalStrip({
  approvals,
}: {
  readonly approvals: readonly CommittedPendingApproval[];
}): ReactElement | null {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [granting, setGranting] = useState<ReadonlySet<ToolRiskCategory>>(() => new Set());
  const [error, setError] = useState<string>();
  if (approvals.length === 0 && !reviewOpen) {
    return null;
  }
  const grant = (category: ToolRiskCategory, grantable: CommittedPendingApproval): void => {
    setGranting((current) => new Set(current).add(category));
    setError(undefined);
    grantable
      .respond({ approved: true, optionId: COMMITTED_SESSION_GRANT_OPTION })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() =>
        setGranting((current) => {
          const next = new Set(current);
          next.delete(category);
          return next;
        })
      );
  };
  const total = approvals.length;
  return (
    <div
      aria-live="polite"
      className="bs-approval-strip"
      data-testid="approval-queue-strip"
      role="status"
    >
      {total > 0 ? (
        <span className="bs-approval-strip-label">
          {total === 1 ? '1 approval waiting' : `${total} approvals waiting`}
        </span>
      ) : null}
      <CommittedApprovalReview
        approvals={approvals}
        onOpenChange={setReviewOpen}
        open={reviewOpen}
      />
      {[...byCategory(approvals)].map(([category, waiting]) => {
        // A grant answers through a call its preview can describe.
        const grantable = waiting.find((approval) => grantsDescribable(previewSubject(approval)));
        return (
          <span className="bs-approval-strip-category" key={category}>
            <span data-testid={`approval-strip-count-${category}`}>
              {countLabel(category, waiting.length)}
            </span>
            {grantable ? (
              <button
                aria-label={`Allow ${RISK_CATEGORY_GRANT_NOUN[category]} this session for the ${waiting.length} waiting ${waiting.length === 1 ? 'approval' : 'approvals'}`}
                className="bs-approval-strip-grant"
                data-testid={`approval-strip-grant-${category}`}
                disabled={granting.has(category)}
                onClick={() => grant(category, grantable)}
                title={`Allow all ${RISK_CATEGORY_GRANT_NOUN[category]} for this session and answer the waiting ${RISK_CATEGORY_GRANT_NOUN[category]}`}
                type="button"
              >
                <Timer aria-hidden="true" className="size-3" />
                Allow {RISK_CATEGORY_GRANT_NOUN[category]} this session
              </button>
            ) : null}
          </span>
        );
      })}
      {error === undefined ? null : <span role="alert">{error}</span>}
    </div>
  );
}
