import { Button } from '@brainstrike/ui';
import { useRef, useState } from 'react';

interface McpTaskInputCancelProps {
  readonly disabled: boolean;
  readonly onCancel: () => Promise<void>;
  readonly onPendingChange: (pending: boolean) => void;
}

/** Keeps the pending task action mounted while main retires its input prompt. */
export function McpTaskInputCancel({
  disabled,
  onCancel,
  onPendingChange,
}: McpTaskInputCancelProps) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async (): Promise<void> => {
    if (disabled || inFlight.current || cancelled) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    onPendingChange(true);
    try {
      await onCancel();
      setCancelled(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'MCP task cancellation failed.');
    } finally {
      inFlight.current = false;
      setPending(false);
      onPendingChange(false);
    }
  };
  return (
    <div className="space-y-2">
      {cancelled ? (
        <p role="status">Task cancelled.</p>
      ) : (
        <Button
          disabled={disabled || pending}
          onClick={() => void cancel()}
          type="button"
          variant="outline"
        >
          {pending ? 'Cancelling task…' : 'Cancel task'}
        </Button>
      )}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
