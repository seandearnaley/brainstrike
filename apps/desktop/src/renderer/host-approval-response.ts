import type { HostClient } from '@brainstrike/agent-host/browser';
import { usePermissionPolicyStore } from '@brainstrike/app-state/stores/permission-policy-store';
import type { ToolRiskCategory } from '@brainstrike/assistant-contract/tool-metadata';
import { type CommittedApprovalGrant, committedApprovalGrant } from '@brainstrike/assistant-ui';

/** A committed approval as the host answers it: its run, and what its grants name. */
export interface HostApprovalTarget {
  readonly interactionId: string;
  /** The tool a per-tool grant names: its catalog ID, else its recorded ID. */
  readonly permissionToolId: string;
  readonly risk?: ToolRiskCategory | undefined;
  readonly runId: string;
  readonly threadId: string;
}

/**
 * "Always allow" also saves the per-tool override in the permission settings,
 * as the approval card's button does, until that write moves to the host's
 * settings owner. A session grant is the host's alone.
 */
function keepToolOverride(grant: CommittedApprovalGrant): void {
  if (grant.scope === 'tool') {
    usePermissionPolicyStore.getState().setToolOverride(grant.toolId, 'allow');
  }
}

/**
 * Answer a committed approval in its own thread. A grant option is committed
 * by the host, which keeps it for the thread's whole delegation tree.
 */
export async function respondToHostApproval(
  client: Pick<HostClient, 'request'>,
  target: HostApprovalTarget,
  response: { readonly approved: boolean; readonly optionId?: string | undefined }
): Promise<void> {
  const grant = committedApprovalGrant(response.optionId, {
    permissionToolId: target.permissionToolId,
    ...(target.risk ? { risk: target.risk } : {}),
  });
  await client.request('interaction/respond', {
    commandId: crypto.randomUUID(),
    decision: response.approved ? 'approve' : 'deny',
    ...(grant ? { grant } : {}),
    interactionId: target.interactionId,
    runId: target.runId,
    threadId: target.threadId,
  });
  if (grant) {
    keepToolOverride(grant);
  }
}
