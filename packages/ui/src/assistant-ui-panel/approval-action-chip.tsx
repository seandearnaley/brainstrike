/**
 * Compact outcome chip for an approval ACTION message ("Approved
 * brainstrike.executeCommand"). The message stays in thread state (the
 * approval notice's outcome locking reads it, and its runConfig drives the
 * resume) but it is transport bookkeeping, not a prompt — so the panel renders
 * this chip instead of a user prompt bubble. Presentation only: no store
 * access, no side effects.
 */

import {
  isAssistantToolApprovalAction,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
} from '@brainstrike/assistant-contract/tool-approval';
import { Check, X } from 'lucide-react';

export interface ApprovalActionChipProps {
  readonly action: 'approve' | 'decline';
  readonly toolName: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Read chip props from a thread message, or `null` when the message is not a
 * user message carrying a valid approval action marker (render the normal
 * prompt bubble). Deliberately validates with the canonical contract guard so
 * a malformed marker degrades to the ordinary bubble, never a wrong chip.
 */
export function readApprovalActionChipProps(message: unknown): ApprovalActionChipProps | null {
  if (!isRecord(message) || message['role'] !== 'user') {
    return null;
  }
  const metadata = message['metadata'];
  if (!isRecord(metadata)) {
    return null;
  }
  const custom = metadata['custom'];
  if (!isRecord(custom)) {
    return null;
  }
  const action = custom[TOOL_APPROVAL_RUN_CONFIG_KEY];
  if (!isAssistantToolApprovalAction(action)) {
    return null;
  }
  return { action: action.action, toolName: action.toolName };
}

/** Stable string key for {@link readApprovalActionChipProps} results (selector-safe). */
export function toApprovalActionChipKey(props: ApprovalActionChipProps | null): string | null {
  return props ? JSON.stringify(props) : null;
}

export function fromApprovalActionChipKey(key: string): ApprovalActionChipProps {
  return JSON.parse(key) as ApprovalActionChipProps;
}

export function ApprovalActionChip({ action, toolName }: ApprovalActionChipProps) {
  const verb = action === 'approve' ? 'Approved' : 'Declined';
  const subject = toolName ?? 'tool call';
  return (
    <div
      className="col-start-2 row-start-2 flex items-center gap-1.5 justify-self-end rounded-full border border-border bg-muted/60 px-3 py-1 text-muted-foreground text-xs"
      data-testid="approval-action-chip"
    >
      {action === 'approve' ? (
        <Check aria-hidden="true" className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <X aria-hidden="true" className="size-3.5" />
      )}
      <span className="truncate">
        {verb} <span className="font-mono">{subject}</span>
      </span>
    </div>
  );
}

ApprovalActionChip.displayName = 'ApprovalActionChip';
