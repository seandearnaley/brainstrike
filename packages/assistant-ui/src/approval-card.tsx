import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import {
  isToolRiskCategory,
  type ToolRiskCategory,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { AlertTriangle, Check, ChevronDown, ChevronUp, ShieldCheck, Timer, X } from 'lucide-react';
import { type CSSProperties, useId, useMemo, useState } from 'react';
import { agentColorStyle } from './agent-color-style';
import { RISK_CATEGORY_GRANT_NOUN } from './approval-notice-status';
import { approvalDepth } from './approval-presentation';
import { ApprovalPreview } from './approval-preview';
import { resolveApprovalPreviewPolicy } from './approval-preview-policy';
import { RediscoveredPauseLines } from './rediscovered-pause-lines';
import { useToolApprovalGrants } from './tool-approval-grant-context';
import type { ApprovalNoticeState } from './use-approval-notice-state';

/**
 * Human-readable reason for the approval, derived from the permission risk
 * bucket that resolved to `'ask'`. Returns `null` when the pause carried no
 * risk hint (e.g. a non-policy approval), so the notice omits the reason rather
 * than inventing one.
 */
const RISK_CATEGORY_REASON: Record<string, string> = {
  edit: 'edit (modifies files or state)',
  // "commands or code": run_python is execute-risk and runs code, not a
  // command — and the wider phrasing reads better for executeCommand too.
  execute: 'execute (runs commands or code on your computer)',
  mcp: 'external MCP tool',
  read: 'read',
};

function resolveApprovalReason(approval: AssistantToolApprovalRequest): string | null {
  const risk = approval.riskCategory;
  if (typeof risk !== 'string') {
    return null;
  }
  return RISK_CATEGORY_REASON[risk] ?? risk;
}

/**
 * The grant risk category for this approval, or `null` when the pause carried
 * no valid risk hint (a non-policy approval) — grants only make sense for
 * policy-driven asks, so the buttons are omitted rather than over-promising.
 */
function resolveGrantCategory(approval: AssistantToolApprovalRequest): ToolRiskCategory | null {
  return isToolRiskCategory(approval.riskCategory) ? approval.riskCategory : null;
}

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

/**
 * The two GRANT actions offered alongside Approve/Decline: "Always allow this
 * tool" (persisted per-tool override) and "Allow <category> this session"
 * (session grant, cleared on reload). Rendered only when a
 * `ToolApprovalGrantProvider` is mounted (app-shell; no provider → null,
 * capability gating) AND the approval is policy-driven (`grantCategory`
 * present) — a non-policy pause must not over-promise a grant.
 *
 * Each button records the grant FIRST, then approves the pending call through
 * the normal resume. Ordering is deliberate: if the approve append fails, the
 * grant has still been recorded, so the retried/next run is already allowed —
 * the safe, least-surprising direction for a button that says "always/this
 * session".
 */
function ApprovalGrantButtons({
  approve,
  disabled,
  grantCategory,
  toolName,
}: {
  approve: () => void;
  disabled: boolean;
  grantCategory: ToolRiskCategory | null;
  toolName: string;
}) {
  const grants = useToolApprovalGrants();
  if (!(grants && grantCategory)) {
    return null;
  }
  const grantNoun = RISK_CATEGORY_GRANT_NOUN[grantCategory];
  return (
    <>
      <Button
        aria-label={`Always allow ${toolName}`}
        data-testid="approval-grant-tool-always"
        disabled={disabled}
        onClick={() => {
          grants.grantToolAlways(toolName);
          approve();
        }}
        size="sm"
        title={`Approve and always allow ${toolName} (persists until removed in Settings > Permissions)`}
        variant="outline"
      >
        <ShieldCheck className="size-3.5" />
        Always allow
      </Button>
      <Button
        aria-label={`Allow ${grantNoun} for this session`}
        data-testid="approval-grant-category-session"
        disabled={disabled}
        onClick={() => {
          grants.grantCategoryForSession(grantCategory);
          approve();
        }}
        size="sm"
        title={`Approve and allow all ${grantNoun} until the app reloads`}
        variant="outline"
      >
        <Timer className="size-3.5" />
        Allow {grantNoun} this session
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More grant options"
            data-testid="approval-grant-overflow"
            disabled={disabled}
            size="sm"
            title="More grant options"
            variant="outline"
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            data-testid="approval-grant-all-session"
            onSelect={() => {
              // Grant FIRST, then approve — same ordering contract as the
              // inline grant buttons (if the approve append fails, the grant is
              // already recorded for the retried/next run).
              grants.grantAllToolsForSession();
              approve();
            }}
          >
            <ShieldCheck className="size-3.5" />
            Allow all tools this session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

export interface ApprovalCardProps {
  readonly approval: AssistantToolApprovalRequest;
  readonly colorId?: string | undefined;
  readonly ownerDisplayName?: string | undefined;
  /**
   * `'card'`: the standalone notice (carries the shared test id and
   * `data-approval-presentation="card"`). `'embedded'`: the body of a
   * collapsed row (`approval-row.tsx`), which owns the test id itself.
   */
  readonly presentation: 'card' | 'embedded';
  readonly state: ApprovalNoticeState;
}

/** What one presentation applies of the delegation nesting. */
interface ApprovalCardNesting {
  readonly style: CSSProperties | undefined;
  /** `.bs-approval`: the indent surface that reads `--bs-approval-depth`. */
  readonly surfaceClassName: 'bs-approval' | undefined;
  readonly testId: 'approval-row-card' | 'assistant-tool-approval-notice';
}

/**
 * The outermost surface owns the nesting. A standalone card carries the
 * `.bs-approval` indent surface and depth; an
 * embedded card carries none of them, because the row already paints all of
 * it and `--bs-approval-depth` inherits (keeping the class would indent twice).
 * Invariant: `'embedded'` is rendered only by `ApprovalRow` (`approval-row.tsx`).
 */
function resolveApprovalCardNesting(
  approval: AssistantToolApprovalRequest,
  presentation: ApprovalCardProps['presentation']
): ApprovalCardNesting {
  switch (presentation) {
    case 'card': {
      return {
        style: { '--bs-approval-depth': approvalDepth(approval) } as CSSProperties,
        surfaceClassName: 'bs-approval',
        testId: 'assistant-tool-approval-notice',
      };
    }
    case 'embedded':
      return {
        style: undefined,
        surfaceClassName: undefined,
        testId: 'approval-row-card',
      };
    default: {
      const exhausted: never = presentation;
      throw new Error(`Unhandled approval card presentation: ${String(exhausted)}`);
    }
  }
}

/** The full approval card: reason, preview, Approve/Decline/grants, raw details. */
export function ApprovalCard({
  approval,
  colorId,
  ownerDisplayName,
  presentation,
  state,
}: ApprovalCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();
  const approvalReason = resolveApprovalReason(approval);
  // BST-1070: a code-execution approval whose args fail strict narrowing or
  // whose execution context is absent/invalid keeps Approve/Decline (the raw
  // JSON is right there) but suppresses the GRANT buttons — no "always allow"
  // for a call we can't read. Suppression reuses the existing null-category
  // capability-gating path in ApprovalGrantButtons rather than adding a
  // second one. Every other tool's previewPolicy is null and unaffected.
  const previewPolicy = resolveApprovalPreviewPolicy(approval);
  const grantCategory = previewPolicy?.suppressGrants ? null : resolveGrantCategory(approval);
  const detailEntries = useMemo(
    () =>
      [
        ['runId', approval.runId],
        ['toolCallId', approval.toolCallId],
        ['args', approval.args],
        ['resumeSchema', approval.resumeSchema],
      ].filter((entry): entry is [string, unknown] => entry[1] !== undefined),
    [approval]
  );
  const nesting = resolveApprovalCardNesting(approval, presentation);

  return (
    <div
      className={cn(nesting.surfaceClassName, 'bs-approval-card my-2 rounded-lg border')}
      data-agent-color={presentation === 'card' ? colorId : undefined}
      data-approval-presentation={presentation}
      data-testid={nesting.testId}
      style={
        presentation === 'card' ? { ...nesting.style, ...agentColorStyle(colorId) } : undefined
      }
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-4 py-3">
        <div
          aria-hidden="true"
          className="flex items-start gap-1.5 pt-0.5"
          data-testid="approval-icon-row"
        >
          <AlertTriangle className="bs-approval-icon size-4" />
        </div>
        <div className="min-w-0">
          <p className="font-medium text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="truncate">
                {state.decisionLocked ? 'Tool decision' : 'Tool approval required'}
              </span>
            </span>
            <span className="bs-approval-status ml-2 rounded-full border px-2 py-0.5 text-[10px]">
              {state.status}
            </span>
          </p>
          {approval.delegation &&
          (ownerDisplayName || state.delegationOwner) &&
          presentation === 'card' ? (
            <p
              className="mt-1 truncate font-medium text-xs"
              data-testid="approval-delegation-owner"
              title={state.delegationOwner ?? ownerDisplayName}
            >
              {ownerDisplayName ?? state.delegationOwner}
            </p>
          ) : null}
          <p className="mt-1 truncate text-muted-foreground text-xs">{approval.toolName}</p>
          {approvalReason ? (
            <p className="bs-approval-reason mt-0.5 truncate text-xs">
              Requires approval: {approvalReason}
            </p>
          ) : null}
          <RediscoveredPauseLines display={state.rediscovered} />
          <ApprovalPreview approval={approval} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              aria-label={`Approve ${approval.toolName}`}
              disabled={state.actionButtonsDisabled}
              onClick={() => state.submitApprovalAction('approve')}
              size="sm"
              title={`Approve ${approval.toolName}`}
              variant="default"
            >
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              aria-label={`Decline ${approval.toolName}`}
              disabled={state.actionButtonsDisabled}
              onClick={() => state.submitApprovalAction('decline')}
              size="sm"
              title={`Decline ${approval.toolName}`}
              variant="outline"
            >
              <X className="size-3.5" />
              Decline
            </Button>
            <ApprovalGrantButtons
              approve={() => state.submitApprovalAction('approve')}
              disabled={state.actionButtonsDisabled}
              grantCategory={grantCategory}
              toolName={approval.toolName}
            />
          </div>
          {state.sendError === null ? null : (
            <p className="mt-2 break-words text-destructive text-xs" role="alert">
              Decision not sent: {state.sendError}
            </p>
          )}
        </div>
        <Button
          aria-controls={isExpanded ? detailsId : undefined}
          aria-expanded={isExpanded}
          aria-label={
            isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'
          }
          className="size-8"
          onClick={() => setIsExpanded((current) => !current)}
          size="icon"
          title={isExpanded ? 'Collapse tool approval details' : 'Expand tool approval details'}
          variant="ghost"
        >
          {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </Button>
      </div>
      {isExpanded ? (
        <div className="border-amber-500/30 border-t border-dashed px-4 py-3" id={detailsId}>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            {detailEntries.map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words text-foreground/90">
                  <pre className="whitespace-pre-wrap font-mono text-[11px] leading-4">
                    {formatJsonValue(value)}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
