import {
  type AppendMessage,
  isMessageNotSentError,
  MessageNotSentError,
} from '@assistant-ui/react';
import type { HostRunSelection } from '@brainstrike/agent-host/protocol';
import type { AssistantThreadHostCapability } from '@brainstrike/app-shell/assistant-thread-host-context';
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { type CommittedHostThreadOptions, startCommittedTurn } from './committed-host-thread';

export interface NewThreadFirstSend {
  /** Commits the new thread's folder and checkout to the thread just created. */
  readonly bind: (threadId: string) => Promise<void>;
  readonly client: CommittedHostThreadOptions['client'];
  /** Opens the created thread as the active tab, with the new thread's settings. */
  readonly commit: (thread: AssistantMemoryThread) => Promise<void>;
  readonly host: Pick<AssistantThreadHostCapability, 'createThread' | 'deleteThread'>;
  readonly resourceId: string;
  readonly runSettings: CommittedHostThreadOptions['runSettings'];
  /** ADR-0019: the composer's model pick, committed as the thread's selection. */
  readonly selection: HostRunSelection | null;
  /**
   * BST-2441: the run command sent to the created thread before its view
   * opens. That view announces what follows it, even rows its replay holds.
   */
  readonly sentBeforeOpening: (threadId: string, commandId: string) => void;
  readonly settleLost?: (threadId: string) => (commandId: string) => Promise<void>;
}

/** Removes the thread a refused first send created; the message goes back to the composer. */
async function discardUnsent(
  host: NewThreadFirstSend['host'],
  threadId: string,
  cause: unknown
): Promise<never> {
  const reason = isMessageNotSentError(cause) ? cause.message : describeBoundaryError(cause);
  try {
    await host.deleteThread(threadId);
  } catch (deleteCause) {
    throw new MessageNotSentError(
      `${reason} The new thread could not be removed: ${describeBoundaryError(deleteCause)}`
    );
  }
  throw isMessageNotSentError(cause) ? cause : new MessageNotSentError(reason);
}

/**
 * The new thread's first send: create the host thread, commit the composer's
 * folder, checkout and model to it, start the run, then open it. A send the
 * host did not admit removes the thread again and gives the composer its
 * message back, so a new thread that never ran leaves nothing behind. A send
 * that may have been admitted keeps and opens the thread.
 */
export async function sendNewThreadFirstMessage(
  send: NewThreadFirstSend,
  message: AppendMessage
): Promise<void> {
  let thread: AssistantMemoryThread;
  try {
    thread = await send.host.createThread(send.resourceId);
  } catch (cause) {
    // Nothing ran, so the composer keeps the message.
    throw isMessageNotSentError(cause)
      ? cause
      : new MessageNotSentError(describeBoundaryError(cause));
  }
  let dispatched = false;
  try {
    await send.bind(thread.id);
    if (send.selection) {
      await send.client.request('thread/selection/set', {
        ...send.selection,
        commandId: crypto.randomUUID(),
        threadId: thread.id,
      });
    }
    dispatched = true;
    const commandId = crypto.randomUUID();
    send.sentBeforeOpening(thread.id, commandId);
    await startCommittedTurn(
      {
        client: send.client,
        runSettings: send.runSettings,
        ...(send.settleLost ? { settleLost: send.settleLost(thread.id) } : {}),
        threadId: thread.id,
      },
      message,
      commandId
    );
  } catch (cause) {
    if (!dispatched || isMessageNotSentError(cause)) {
      await discardUnsent(send.host, thread.id, cause);
    }
    await send.commit(thread);
    throw cause;
  }
  await send.commit(thread);
}
