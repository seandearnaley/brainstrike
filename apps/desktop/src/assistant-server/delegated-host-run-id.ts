import { createHash } from 'node:crypto';
import type { DelegatedRunIdentity } from '@brainstrike/agent';

/** Opaque host-leg identity shared by event persistence and edit attribution. */
export function delegatedHostRunId(
  hostRunId: string,
  identity: Pick<
    DelegatedRunIdentity,
    'parentRuntimeRunId' | 'parentToolCallId' | 'childRuntimeRunId'
  >
): string {
  return `delegated-run-${createHash('sha256')
    .update(
      JSON.stringify([
        hostRunId,
        identity.parentRuntimeRunId,
        identity.parentToolCallId,
        identity.childRuntimeRunId,
      ])
    )
    .digest('hex')}`;
}
