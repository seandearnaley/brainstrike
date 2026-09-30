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
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
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

/**
 * `run_python`'s Gate B network decision (BST-1070). Deliberately does NOT name
 * the domains: the persisted action message carries only the user's verdict,
 * while the card directly above already lists the domains. Repeating them here
 * is the redundancy this chip exists to remove.
 *
 * The one-key check validates that persisted, pre-transport notice payload. The
 * resume transport may subsequently add the framework-required
 * `{approved: true}` rider before `run-python-tool.ts` reads the decision; that
 * enriched execution payload is a different boundary. Keeping this recognizer
 * strict prevents malformed or unrelated action records from claiming that
 * internet access was allowed.
 */
function readNetworkDecisionChip(
  resumeData: Record<string, unknown>
): ApprovalActionChipProps | null {
  if (Reflect.ownKeys(resumeData).length !== 1) {
    return null;
  }
  const decision = resumeData['action'];
  if (decision === 'allow') {
    return { label: 'Allowed internet access', tone: 'approve' };
  }
  if (decision === 'deny') {
    return { label: "Didn't allow internet access", tone: 'decline' };
  }
  return null;
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

function readAnswerChip(answerValue: unknown): ApprovalActionChipProps | null {
  const answer = readAnswerText(answerValue);
  if (answer === null) {
    return null;
  }
  const truncated =
    answer.length > ANSWER_LABEL_CHAR_CAP
      ? `${sliceCodePoints(answer, ANSWER_LABEL_CHAR_CAP)}…`
      : answer;
  return { label: `Answered: ${truncated}`, tone: 'answer' };
}

function readSuspendChip(marker: unknown): ApprovalActionChipProps | null {
  if (!isAssistantToolResumeAction(marker)) {
    return null;
  }
  // The suspend notice produces exactly these resumeData shapes: a submitPlan
  // decision record, a run_python network decision record, or an askUser
  // `{answer}` envelope (AskUserResumeData). The bare string/string[] arm below
  // is the LEGACY pre-envelope askUser answer, kept so persisted pre-migration
  // action messages still chip. Anything else is unrecognized — fall through to
  // the bubble.
  //
  // The network arm is keyed by TOOL NAME, because `{action: 'allow'}` is
  // meaningful only as run_python's Gate B verdict. The suspend contract states
  // the convention ("the UI narrows it by `toolName`", tool-suspend.ts) and the
  // notice dispatches the same way, so a future suspending tool reusing this
  // vocabulary cannot inherit the network label. `toolName` is optional in the
  // contract; absent means unattributable, which falls through to the bubble
  // rather than guessing. run_python never produces an askUser envelope, so its
  // records deliberately do NOT fall on to the answer arm.
  if (isRecord(marker.resumeData)) {
    const planChip = readPlanDecisionChip(marker.resumeData);
    if (planChip) {
      return planChip;
    }
    if (marker.toolName === NATIVE_TOOL_ID.runPython) {
      return readNetworkDecisionChip(marker.resumeData);
    }
    return readAnswerChip(marker.resumeData['answer']);
  }
  return readAnswerChip(marker.resumeData);
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
    return <Check aria-hidden="true" className="size-3.5 text-success" />;
  }
  if (tone === 'decline') {
    return <X aria-hidden="true" className="size-3.5" />;
  }
  return <MessageSquare aria-hidden="true" className="size-3.5 text-info" />;
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
