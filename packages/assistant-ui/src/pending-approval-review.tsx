import { getToolActionIdentityKey } from '@brainstrike/assistant-contract';
import type { AssistantToolApprovalRequest } from '@brainstrike/assistant-contract/tool-approval';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { BellRing, X } from 'lucide-react';
import { AssistantToolApprovalDataPart } from './assistant-tool-approval-data-part';

/** A view of the thread's existing decision index, never a second approval queue. */
export function PendingApprovalReview({
  requests,
  open,
  onOpenChange,
}: {
  readonly requests: readonly AssistantToolApprovalRequest[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Review ${requests.length} pending ${requests.length === 1 ? 'approval' : 'approvals'}`}
          className="gap-2"
          size="sm"
          variant="outline"
        >
          <BellRing aria-hidden="true" className="size-3.5" />
          Review {requests.length}
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
            <p className="text-muted-foreground text-xs">
              Requests in timeline order. Review the action before approving.
            </p>
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
        <div className="assistant-ui-panel">
          {requests.length === 0 ? (
            <p className="p-3 text-muted-foreground text-sm" role="status">
              All approvals handled.
            </p>
          ) : (
            requests.map((request) => (
              <AssistantToolApprovalDataPart
                data={request}
                key={getToolActionIdentityKey(request)}
                presentation="review"
              />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
