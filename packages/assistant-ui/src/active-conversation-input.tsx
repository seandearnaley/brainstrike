import { useAui, useAuiState } from '@assistant-ui/react';
import { type ReactNode, useRef, useState } from 'react';
import {
  ActiveInputContext,
  type SendActiveConversationInput,
} from './active-conversation-input-context';

/** Uses the normal composer draft while the existing host owns execution. */
export function ActiveConversationInputProvider({
  children,
  onSend,
}: {
  readonly children: ReactNode;
  readonly onSend?: SendActiveConversationInput | undefined;
}) {
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const inFlight = useRef(false);
  const request = useRef<{ id: string; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = async () => {
    if (!(onSend && running) || inFlight.current) {
      return;
    }
    const text = aui.composer().getState().text.trim();
    if (!text) {
      return;
    }
    if (request.current?.text !== text) {
      request.current = { id: crypto.randomUUID(), text };
    }
    const input = request.current;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(input);
      if (aui.composer().getState().text.trim() === text) {
        aui.composer().setText('');
      }
      request.current = undefined;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Child input delivery was not confirmed.'
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <ActiveInputContext value={onSend && running ? { busy, error, send } : undefined}>
      {children}
    </ActiveInputContext>
  );
}
