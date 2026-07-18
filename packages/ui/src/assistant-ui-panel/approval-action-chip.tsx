/**
 * Compact outcome chip for approval/suspend ACTION messages ("Approved
 * brainstrike.executeCommand", "Approved the plan", "Answered: …"). Those
 * messages stay in thread state (the notices' outcome locking reads them, and
 * their runConfig drives the resume) but they are transport bookkeeping, not
 * prompts — so the panel renders this chip instead of a user prompt bubble.
 * Presentation only: no store access, no side effects.
 *
 * STRICT recognizers: a marker that is missing, structurally invalid, or whose
 * `resumeData` shape is not one the suspend notice actually produces returns
 * `null` and the message renders as the ordinary bubble — user-visible content
 * is never hidden behind a guessed chip (no-silent-fallbacks).
 */

import {
  isAssistantToolApprovalAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import {
  isAssistantToolResumeAction,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-suspend';
import { sliceCodePoints } from '@brainstrike/utils/string-utils';
import { Check, MessageSquare, X } from 'lucide-react';

/** Max answer characters shown on an "Answered: …" chip before truncation. */
const ANSWER_LABEL_CHAR_CAP = 60;

export interface ApprovalActionChipProps {
  /** Full human-readable outcome text ("Approved", "Rejected the plan", …). */
  readonly label: string;
  /** Drives the icon: check / x / speech bubble. */
  readonly tone: 'approve' | 'decline' | 'answer';
  /** Mono-rendered tool-name suffix (per-tool approval chips only). */
  readonly toolName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readCustomMetadata(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || message['role'] !== 'user') {
    return null;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return null;
  }
  const custom = metadata['custom'];
  return isRecord(custom) ? custom : null;
}

function readApprovalChip(marker: unknown): ApprovalActionChipProps | null {
  if (!isAssistantToolApprovalAction(marker)) {
    return null;
  }
  const verb = marker.action === 'approve' ? 'Approved' : 'Declined';
  const tone = marker.action === 'approve' ? ('approve' as const) : ('decline' as const);
  if (marker.toolName) {
    return { label: verb, tone, toolName: marker.toolName };
  }
  return { label: `${verb} tool call`, tone };
}

function readPlanDecisionChip(resumeData: Record<string, unknown>): ApprovalActionChipProps | null {
  const decision = resumeData['action'];
  if (decision !== 'approved' && decision !== 'rejected') {
    return null;
  }
  const feedback = resumeData['feedback'];
  const feedbackNote = typeof feedback === 'string' && feedback.trim() ? ' (with feedback)' : '';
  if (decision === 'approved') {
    return { label: `Approved the plan${feedbackNote}`, tone: 'approve' };
  }
  return { label: `Rejected the plan${feedbackNote}`, tone: 'decline' };
}

function readAnswerText(resumeData: unknown): string | null {
  if (typeof resumeData === 'string') {
    const trimmed = resumeData.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (
    Array.isArray(resumeData) &&
    resumeData.length > 0 &&
    resumeData.every((entry): entry is string => typeof entry === 'string')
  ) {
    const joined = resumeData.join(', ').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

function readSuspendChip(marker: unknown): ApprovalActionChipProps | null {
  if (!isAssistantToolResumeAction(marker)) {
    return null;
  }
  // The suspend notice produces exactly these resumeData shapes: a submitPlan
  // decision record, or an askUser answer (free-text string / string array).
  // Anything else is unrecognized — fall through to the bubble.
  if (isRecord(marker.resumeData)) {
    return readPlanDecisionChip(marker.resumeData);
  }
  const answer = readAnswerText(marker.resumeData);
  if (answer === null) {
    return null;
  }
  const truncated =
    answer.length > ANSWER_LABEL_CHAR_CAP
      ? `${sliceCodePoints(answer, ANSWER_LABEL_CHAR_CAP)}…`
      : answer;
  return { label: `Answered: ${truncated}`, tone: 'answer' };
}

/**
 * Read chip props from a thread message, or `null` when the message is not a
 * user message carrying a valid approval/suspend action marker (render the
 * normal prompt bubble). Validates with the canonical contract guards so a
 * malformed marker degrades to the ordinary bubble, never a wrong chip.
 */
export function readApprovalActionChipProps(message: unknown): ApprovalActionChipProps | null {
  const custom = readCustomMetadata(message);
  if (!custom) {
    return null;
  }
  const approvalChip = readApprovalChip(custom[TOOL_APPROVAL_RUN_CONFIG_KEY]);
  if (approvalChip) {
    return approvalChip;
  }
  return readSuspendChip(custom[TOOL_SUSPEND_RUN_CONFIG_KEY]);
}

/** Stable string key for {@link readApprovalActionChipProps} results (selector-safe). */
export function toApprovalActionChipKey(props: ApprovalActionChipProps | null): string | null {
  return props ? JSON.stringify(props) : null;
}

export function fromApprovalActionChipKey(key: string): ApprovalActionChipProps {
  return JSON.parse(key) as ApprovalActionChipProps;
}

function ChipIcon({ tone }: { tone: ApprovalActionChipProps['tone'] }) {
  if (tone === 'approve') {
    return <Check aria-hidden="true" className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
  }
  if (tone === 'decline') {
    return <X aria-hidden="true" className="size-3.5" />;
  }
  return <MessageSquare aria-hidden="true" className="size-3.5 text-sky-600 dark:text-sky-400" />;
}

export function ApprovalActionChip({ label, tone, toolName }: ApprovalActionChipProps) {
  return (
    <div
      className="col-start-2 row-start-2 flex items-center gap-1.5 justify-self-end rounded-full border border-border bg-muted/60 px-3 py-1 text-muted-foreground text-xs"
      data-testid="approval-action-chip"
    >
      <ChipIcon tone={tone} />
      <span className="truncate">
        {label}
        {toolName ? (
          <>
            {' '}
            <span className="font-mono">{toolName}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

ApprovalActionChip.displayName = 'ApprovalActionChip';
