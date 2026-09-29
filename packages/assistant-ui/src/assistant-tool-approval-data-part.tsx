import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import { use, useEffect, useEffectEvent, useState } from 'react';
import { AssistantToolApprovalNotice } from './assistant-tool-approval-notice';
import {
  type DelegatedApprovalOwner,
  DelegatedApprovalOwnerContext,
} from './subagent-conversation-navigation';
import { isAssistantToolApprovalRequest } from './tool-decision-run-outcome';

export function AssistantToolApprovalDataPart({
  data,
  presentation,
}: {
  readonly data: unknown;
  readonly presentation?: 'timeline' | 'review';
}) {
  const resolveOwner = use(DelegatedApprovalOwnerContext);
  const [resolved, setResolved] = useState<{
    key: string;
    owner: DelegatedApprovalOwner | undefined;
    resolver: typeof resolveOwner;
  } | null>(null);
  const approval = isAssistantToolApprovalRequest(data) ? data : null;
  const key = approval
    ? JSON.stringify([getToolActionIdentityKey(approval), approval.delegation?.path])
    : null;
  const readApproval = useEffectEvent(() => approval);
  useEffect(() => {
    const request = readApproval();
    if (!(request?.delegation && resolveOwner && key)) {
      return;
    }
    let active = true;
    resolveOwner(request).then(
      (owner) => {
        if (active) {
          setResolved({ key, owner, resolver: resolveOwner });
        }
      },
      () => {
        if (active) {
          setResolved({ key, owner: undefined, resolver: resolveOwner });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [key, resolveOwner]);
  const isCurrentResolution = resolved?.key === key && resolved.resolver === resolveOwner;
  const owner = isCurrentResolution ? resolved.owner : undefined;
  const colorId = approval?.delegation ? (owner?.colorId ?? 'unresolved') : undefined;
  const ownerUnavailable =
    approval?.delegation && (!resolveOwner || (isCurrentResolution && !resolved.owner));
  return (
    <>
      {ownerUnavailable ? (
        <div className="text-muted-foreground text-xs" role="status">
          Approval owner unavailable: child identity could not be verified.
        </div>
      ) : null}
      <AssistantToolApprovalNotice
        colorId={colorId}
        data={data}
        ownerDisplayName={owner?.displayName}
        presentation={presentation}
      />
    </>
  );
}
