import type { ToolApprovalOption } from '@assistant-ui/react';
import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { RISK_CATEGORY_GRANT_NOUN } from './approval-notice-status';
import {
  type ApprovalPreviewSubject,
  resolveApprovalPreviewPolicy,
} from './approval-preview-policy';

/** A permission grant answered with a host approval (the host's `interaction/respond` grant). */
export type CommittedApprovalGrant =
  | { readonly category: ToolRiskCategory; readonly scope: 'session' }
  | { readonly scope: 'tool'; readonly toolId: string };

const GRANT_TOOL = 'grant-tool';
/** The option that grants the approval's risk category for the session. */
export const COMMITTED_SESSION_GRANT_OPTION = 'grant-session';
const GRANT_SESSION = COMMITTED_SESSION_GRANT_OPTION;

/**
 * A committed permission approval's answers, as the vendor's approval options:
 * once, always for this tool, this risk category for the session, or decline.
 */
export function committedApprovalOptions(risk: ToolRiskCategory): readonly ToolApprovalOption[] {
  return [
    { id: 'approve', kind: 'allow-once', label: 'Approve' },
    { id: GRANT_TOOL, kind: 'allow-always', label: 'Always allow' },
    {
      id: GRANT_SESSION,
      kind: '_allow-session',
      label: `Allow ${RISK_CATEGORY_GRANT_NOUN[risk]} this session`,
    },
    { id: 'deny', kind: 'reject-once', label: 'Decline' },
  ];
}

/** The grant a chosen option asks for, named from the pending call's own category or tool. */
export function committedApprovalGrant(
  optionId: string | undefined,
  interaction: { readonly permissionToolId: string; readonly risk?: ToolRiskCategory }
): CommittedApprovalGrant | undefined {
  if (optionId === GRANT_TOOL) {
    return { scope: 'tool', toolId: interaction.permissionToolId };
  }
  if (optionId !== GRANT_SESSION) {
    return;
  }
  if (!interaction.risk) {
    throw new Error('A session grant needs its approval’s risk category');
  }
  return { category: interaction.risk, scope: 'session' };
}

/** A decision as its button offers it: the approval it gives and the option it names. */
export interface ApprovalDecision {
  readonly approved: boolean;
  readonly label: string;
  readonly optionId?: string;
}

/**
 * A decision's buttons: the request's own options when it carries them (the
 * host's grants), else the plain Approve / Decline pair.
 */
export function approvalDecisions(
  options: readonly ToolApprovalOption[] | undefined
): readonly ApprovalDecision[] {
  if (!options?.length) {
    return [
      { approved: true, label: 'Approve' },
      { approved: false, label: 'Decline' },
    ];
  }
  return options.map((option) => ({
    approved: !option.kind.startsWith('reject'),
    label: option.label ?? option.id,
    optionId: option.id,
  }));
}

/** The grant options: kept only when the preview can describe the call it would grant. */
const GRANT_OPTION_KINDS = new Set(['allow-always', '_allow-session']);

/** True when the approval preview can describe the call a grant would allow again. */
export function grantsDescribable(subject: ApprovalPreviewSubject): boolean {
  return resolveApprovalPreviewPolicy(subject)?.suppressGrants !== true;
}

/** A pending call's options: a code-execution call the preview cannot describe offers no grant. */
export function describableApprovalOptions(
  options: readonly ToolApprovalOption[] | undefined,
  subject: ApprovalPreviewSubject
): readonly ToolApprovalOption[] | undefined {
  return grantsDescribable(subject)
    ? options
    : options?.filter((option) => !GRANT_OPTION_KINDS.has(option.kind));
}
