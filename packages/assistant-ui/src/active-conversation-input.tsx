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
  const cancelWait = useRef<(() => void) | undefined>(undefined);
  const request = useRef<{ id: string; text: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canSend = Boolean(onSend && running && !busy);
  const send = async () => {
    if (!(onSend && running) || inFlight.current) {
      return;
    }
    const text = aui.composer().getState().text.trim();
    if (!text) {
      return;
    }
    if (request.current && request.current.text !== text) {
      setError(
        'The earlier input is unconfirmed. Inspect the child and use Discard draft before composing a new input.'
      );
      return;
    }
    if (!request.current) {
      request.current = { id: crypto.randomUUID(), text };
    }
    const input = request.current;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    const interrupted = Promise.withResolvers<void>();
    cancelWait.current = () => {
      const failure = new Error(
        'Waiting stopped. Delivery is unconfirmed; inspect the child before retrying or discarding this draft.'
      );
      interrupted.reject(failure);
      controller.abort(failure);
    };
    try {
      await Promise.race([onSend(input, controller.signal), interrupted.promise]);
      if (aui.composer().getState().text.trim() === text) {
        aui.composer().setText('');
      }
      request.current = undefined;
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Child input delivery was not confirmed.'
      );
    } finally {
      cancelWait.current = undefined;
      inFlight.current = false;
      setBusy(false);
    }
  };
  const discard = () => {
    if (inFlight.current) {
      return;
    }
    request.current = undefined;
    aui.composer().setText('');
    setError(undefined);
  };
  return (
    <ActiveInputContext
      value={
        canSend || busy || error !== undefined
          ? { busy, canSend, discard, error, send, stopWaiting: () => cancelWait.current?.() }
          : undefined
      }
    >
      {children}
    </ActiveInputContext>
  );
}
