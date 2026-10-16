/**
 * A host thread's committed conversation over any host client, desktop's or
 * the browser's (BST-1940; owner decision, 16 Oct: one shared core): the
 * thread's committed session, the store its view folds, and the commands
 * every host serves (send, edit, Stop). Desktop composes its other features
 * over it (approvals, checkpoints, verdicts, MCP input, steering, regeneration).
 */
import { type AppendMessage, MessageNotSentError } from '@assistant-ui/react';
import { isConnectionLoss } from '@brainstrike/agent-host/boundary-wire';
import type { HostClient } from '@brainstrike/agent-host/browser';
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import {
  HOST_RUN_NOT_ADMITTED_CODE,
  type HostImageAttachment,
  HostImageAttachmentSchema,
  type HostLogRow,
  type HostParams,
} from '@brainstrike/agent-host/protocol';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import { BoundaryFailureError, describeBoundaryError } from '@brainstrike/assistant-contract';
import {
  type CommittedAssistantCommands,
  type CommittedAssistantLogRow,
  CommittedAssistantLogStore,
  type CommittedAssistantRunIdentity,
  LiveShellOutputs,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';

const logger = createLogger('CommittedHostConversation');

/** A committed run.started the host admitted to deliver child results (a wake). */
const HostWakeStartSchema = z.object({
  delivery: z.object({ via: z.literal('wake') }),
  type: z.literal('run.started'),
});

/** A composer image as the host's user-message attachment; anything else is refused. */
function hostImageAttachment(
  attachment: NonNullable<AppendMessage['attachments']>[number]
): HostImageAttachment {
  const image = attachment.content.find((part) => part.type === 'image');
  if (attachment.type !== 'image' || !image) {
    throw new Error('The agent host accepts image attachments only');
  }
  return HostImageAttachmentSchema.parse({
    data: image.image,
    mediaType: attachment.contentType?.toLowerCase(),
    name: attachment.name,
    type: 'image',
  });
}

/** The view's message identities for a committed run, from its host's own identities. */
export function committedConversationIdentity(
  rows: readonly HostLogRow[],
  row: CommittedAssistantLogRow
): CommittedAssistantRunIdentity {
  const runId = row.event['runId'];
  if (typeof runId !== 'string') {
    throw new Error('Committed conversation has no run identity');
  }
  // The message names the host run it answers, for its delegation cards.
  const identity = {
    ...committedRunIdentity(rows, runId),
    metadata: { custom: { hostRunId: runId } },
  };
  // BST-1932: a wake answers the host's child delivery, not a person; its
  // ledger is model input, so the answer follows the run it woke behind.
  if (HostWakeStartSchema.safeParse(row.event).success) {
    const { userMessageId: _ledger, ...wake } = identity;
    return wake;
  }
  return identity;
}

/** A host refusal's JSON-RPC code; undefined for a failure that never reached the host. */
export function hostErrorCode(cause: unknown): number | undefined {
  const response = cause instanceof BoundaryFailureError ? cause.cause : cause;
  const code: unknown =
    typeof response === 'object' && response !== null && 'code' in response
      ? response.code
      : undefined;
  return typeof code === 'number' ? code : undefined;
}

/**
 * BST-1990 (D4): the host refused the run before admitting it (its JSON-RPC
 * code says so), so nothing was committed and the user's message may be sent
 * again. The code is read structurally: the client's error class is bundled.
 */
function isRunNotAdmitted(cause: unknown): cause is Error {
  return cause instanceof Error && hostErrorCode(cause) === HOST_RUN_NOT_ADMITTED_CODE;
}

export interface CommittedHostThreadOptions {
  /**
   * Before a send's `run/start` (desktop binds the thread to its folder, as
   * legacy's first request did); a refusal fails the send.
   */
  readonly beforeStart?: () => Promise<void>;
  readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry' | 'request'>;
  /** Told when a newer committed title, colour or icon reaches this view. */
  readonly onTitleCommitted?: () => void;
  /** The model, configuration and plan mode of the next run this view starts. */
  readonly runSettings: () => Pick<
    HostParams<'run/start'>,
    'configuration' | 'modelId' | 'planMode'
  >;
  /**
   * BST-2004: settles a send whose host was lost before it answered, from the
   * host's replacement; without it, the loss fails the send.
   */
  readonly settleLost?: (commandId: string) => Promise<void>;
  readonly threadId: string;
}

export interface CommittedHostThread {
  /** Release this view's subscription; the client belongs to its caller. */
  close(): void;
  readonly commands: {
    readonly [Command in
      | 'onCancel'
      | 'onDelete'
      | 'onEdit'
      | 'onNew'
      | 'setMessages']-?: NonNullable<CommittedAssistantCommands[Command]>;
  };
  /**
   * Subscribe the session. A caller composing more of the view over the
   * session constructs it first, so it sees the replay.
   */
  connect(): void;
  readonly source: CommittedThreadSession;
  readonly store: CommittedAssistantLogStore;
}

/** Construct alongside the attached client, outside React render. */
export function createCommittedHostThread(
  options: CommittedHostThreadOptions
): CommittedHostThread {
  const { client, threadId } = options;
  const source = new CommittedThreadSession(client, threadId);
  // A running command's output arrives as uncommitted telemetry; its committed
  // result owns the output from then on (ADR-0011 amendment).
  const liveShellOutputs = new LiveShellOutputs();
  const releaseResults = client.onEvent((row) => {
    if (row.threadId === threadId && row.event.type === 'effect.finished') {
      liveShellOutputs.clear(row.event.toolCallId);
    }
  });
  const store = new CommittedAssistantLogStore({
    identifyRun: (row) => committedConversationIdentity(source.getSnapshot().rows, row),
    liveShellOutputs,
    source,
    threadId,
  });
  // A tool's live output and the model's live text and reasoning, from the
  // session: its subscription's replay over the rows, then each live chunk
  // once. Each consumer takes only its own chunk types.
  const releaseTelemetry = source.onTelemetry((telemetry) => {
    liveShellOutputs.accept(telemetry.chunk);
    store.acceptTelemetry(telemetry.runId, telemetry.chunk);
  });
  const { settleLost } = options;
  // A send, a send from a selected branch, and an edit all start a new user
  // message after the vendor's explicit parent (null: the thread root).
  const startTurn = async (message: AppendMessage): Promise<void> => {
    if (message.content.some((part) => part.type !== 'text')) {
      throw new Error('This host command requires text input');
    }
    const attachments = (message.attachments ?? []).map(hostImageAttachment);
    const prompt = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const commandId = crypto.randomUUID();
    // BST-2004: a send whose host was lost before it answered, or before the
    // send left, is settled from the replacement's committed log; nothing is resent.
    try {
      await options.beforeStart?.();
    } catch (cause) {
      if (settleLost && isConnectionLoss(cause)) {
        return await settleLost(commandId);
      }
      throw cause;
    }
    try {
      await client.request('run/start', {
        ...(attachments.length > 0 ? { attachments } : {}),
        commandId,
        ...options.runSettings(),
        parentMessageId: message.parentId,
        prompt,
        threadId,
      });
    } catch (cause) {
      if (settleLost && isConnectionLoss(cause)) {
        return await settleLost(commandId);
      }
      // BST-1990 (D4): logged with the host's code (the user reads its text).
      logger.warn('The agent host refused a run command', {
        code: hostErrorCode(cause),
        method: 'run/start',
        threadId,
      });
      // Not sent: the vendor gives the composer its draft back.
      throw isRunNotAdmitted(cause) ? new MessageNotSentError(describeBoundaryError(cause)) : cause;
    }
  };
  let titleSeq = -1;
  const unsubscribeTitles = source.subscribe(() => {
    const renamed = source
      .getSnapshot()
      .rows.findLast((row) => row.event.type === 'thread.updated');
    if (renamed && renamed.seq > titleSeq) {
      titleSeq = renamed.seq;
      options.onTitleCommitted?.();
    }
  });
  let disconnect: (() => Promise<void>) | undefined;
  return {
    close: () => {
      releaseTelemetry();
      releaseResults();
      unsubscribeTitles();
      // The client outlives this view, so the unsubscribe is not joined here;
      // its refusal is reported, never swallowed.
      disconnect?.().catch((error: unknown) => {
        logger.error('Committed conversation unsubscribe failed', { error, threadId });
      });
      store.dispose();
    },
    commands: {
      onCancel: async () => {
        const runId = store.getCommittedView().activeRunId;
        if (!runId) {
          throw new Error('Stop has no committed active root run');
        }
        await client.request('run/stop', { commandId: crypto.randomUUID(), runId, threadId });
      },
      // Committed messages are immutable; the installed vendor would otherwise
      // evict a "deleted" message locally through the branch-selection port.
      onDelete: () => {
        throw new Error('Committed conversation messages cannot be deleted');
      },
      onEdit: (message) => startTurn(message),
      onNew: (message) => startTurn(message),
      // Branch selection is client view state: the vendor already moved its own
      // head over the committed tree, and nothing is written to the host.
      setMessages: () => undefined,
    },
    connect: () => {
      disconnect ??= source.connect();
    },
    source,
    store,
  };
}
