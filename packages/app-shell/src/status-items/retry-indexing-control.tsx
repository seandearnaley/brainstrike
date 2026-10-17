import { Button } from '@brainstrike/ui';
import { Loader2 } from 'lucide-react';
import type { RetryIndexingAction } from './use-retry-indexing';

/** A failed Retry indexing, announced in the owner's typed words (BST-2104). */
export function RetryIndexingFailure({ action }: { readonly action: RetryIndexingAction }) {
  if (action.failure === null) {
    return null;
  }
  return (
    <div className="text-destructive text-xs" role="alert">
      Retry indexing failed: {action.failure}
    </div>
  );
}

/** The remedy for an embedding host that stopped responding: restart it and resume indexing. */
export function RetryIndexingButton({ action }: { readonly action: RetryIndexingAction }) {
  return (
    <Button
      aria-busy={action.pending}
      disabled={action.pending}
      onClick={action.retry}
      size="sm"
      title="Restarts the embedding model and resumes indexing."
      type="button"
    >
      {action.pending ? (
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      ) : null}
      Retry indexing
    </Button>
  );
}
