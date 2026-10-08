import type { ToolApprovalOption } from '@assistant-ui/react';
import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { RISK_CATEGORY_GRANT_NOUN } from './approval-notice-status';

/** A permission grant answered with a host approval (the host's `interaction/respond` grant). */
export type CommittedApprovalGrant =
  | { readonly category: ToolRiskCategory; readonly scope: 'session' }
  | { readonly scope: 'tool'; readonly toolId: string };

const GRANT_TOOL = 'grant-tool';
const GRANT_SESSION = 'grant-session';

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
