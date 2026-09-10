import { isSuspendedRunDiscoveryError } from '@brainstrike/assistant-contract';
import { CircleAlertIcon } from 'lucide-react';

export const AssistantDiscoveryErrorNotice = ({ data }: { data: unknown }) => {
  if (!isSuspendedRunDiscoveryError(data)) {
    throw new Error('Invalid pending decision recovery status.');
  }
  return (
    <div
      className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
      role="alert"
    >
      <CircleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Pending decisions could not be restored</p>
        <p className="text-muted-foreground">
          {data.reason === 'timed-out' ? 'The assistant server did not respond in time. ' : null}
          Reopen this thread to check again. Your conversation is still available.
        </p>
      </div>
    </div>
  );
};
