import { useAui, useAuiState } from '@assistant-ui/react';
import {
  type AssistantChildInput,
  serializeAssistantChildInput,
} from '@brainstrike/assistant-contract';
import { type ReactNode, useRef, useState } from 'react';
import {
  ActiveInputContext,
  type SendActiveConversationInput,
} from './active-conversation-input-context';
import {
  captureChildInputDraft,
  clearAcknowledgedChildDraft,
} from './active-conversation-input-draft';

/** Uses the normal composer draft while the existing host owns execution. */
export function ActiveConversationInputProvider({
  children,
  onSend,
  allowIdleInput = false,
}: {
  readonly children: ReactNode;
  readonly allowIdleInput?: boolean;
  readonly onSend?: SendActiveConversationInput | undefined;
}) {
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const inFlight = useRef(false);
  const cancelWait = useRef<(() => void) | undefined>(undefined);
  const request = useRef<AssistantChildInput | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canSend = Boolean(onSend && (running || allowIdleInput) && !busy);
  const send = async () => {
    if (!(onSend && canSend) || inFlight.current) {
      return;
    }
    const draft = aui.composer().getState();
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (!text && attachments.length === 0) {
      return;
    }
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
      const deliver = async () => {
        const input = await captureChildInputDraft(
          request.current?.id ?? crypto.randomUUID(),
          text,
          attachments
        );
        controller.signal.throwIfAborted();
        if (
          request.current &&
          serializeAssistantChildInput(request.current) !== serializeAssistantChildInput(input)
        ) {
          throw new Error(
            'The earlier input is unconfirmed. Inspect the child and use Discard draft before composing a new input.'
          );
        }
        request.current = input;
        await onSend(input, controller.signal);
      };
      await Promise.race([deliver(), interrupted.promise]);
      await clearAcknowledgedChildDraft(aui, text, attachments);
      request.current = undefined;
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message.trim()
          ? failure.message
          : 'Child input delivery was not confirmed.'
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
    aui.composer().clearAttachments();
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
