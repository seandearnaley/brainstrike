import { type AppendMessage, MessageNotSentError } from '@assistant-ui/react';
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
import {
  type AssistantChildAttachment,
  type AssistantChildInput,
  BoundaryFailureError,
  describeBoundaryError,
} from '@brainstrike/assistant-contract';
import {
  type CommittedAssistantCommands,
  type CommittedAssistantLogRow,
  CommittedAssistantLogStore,
  type CommittedAssistantRunIdentity,
  LiveShellOutputs,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { CommittedHostCheckpoints } from './committed-host-checkpoints';
import { CommittedHostMcpInput } from './committed-host-mcp-input';
import { CommittedHostVerdicts } from './committed-host-verdicts';
import { respondToHostApproval, resumeHostInteraction } from './host-approval-response';
import { HostTreeApprovals } from './host-tree-approvals';

const logger = createLogger('CommittedHostConversation');

/** A committed run.started the host admitted to deliver child results (a wake). */
const HostWakeStartSchema = z.object({
  delivery: z.object({ via: z.literal('wake') }),
  type: z.literal('run.started'),
});

/** A child input's image as the host's user-message attachment; anything else is refused. */
function childImageAttachment(attachment: AssistantChildAttachment): HostImageAttachment {
  return HostImageAttachmentSchema.parse({
    data: attachment.data,
    mediaType: attachment.mediaType.toLowerCase(),
    name: attachment.filename,
    type: 'image',
  });
}

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

/** The desktop's message identities for a committed run, from its host's own identities. */
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

export interface CommittedHostConversation {
  /** BST-1932: the approvals waiting in this thread and every thread delegated beneath it. */
  readonly approvals: HostTreeApprovals;
  /** The thread's committed edit checkpoints, reverted through the host. */
  readonly checkpoints: CommittedHostCheckpoints;
  /** Release this view's subscription; the client/root host belongs to its caller. */
  close(): void;
  readonly commands: CommittedAssistantCommands;
  readonly mcpInput: CommittedHostMcpInput;
  /**
   * BST-1932: human input for this running child. The host ends the active run
   * after its step in flight and starts the input as the child's next run.
   */
  sendInput(input: AssistantChildInput, signal: AbortSignal): Promise<void>;
  /** The thread's committed session; this conversation connects and releases it. */
  readonly source: CommittedThreadSession;
  /**
   * Steer the active run: Core ends it after its step in flight. Resolves to
   * the steered run, or undefined when no run was left to steer.
   */
  steer(): Promise<string | undefined>;
  readonly store: CommittedAssistantLogStore;
  /** The thread's committed run verdicts, recorded through the host. */
  readonly verdicts: CommittedHostVerdicts;
}

/** What the next run this view starts takes from the composer's current settings. */
export interface HostRunSettingsSource {
  readonly modelId: string;
  readonly readConfiguration?: () => Record<string, unknown>;
  readonly readModelId?: () => string;
  /** Plan mode for the next run this view starts; absent is off. */
  readonly readPlanMode?: () => boolean;
}

/** The model, configuration and plan mode a `run/start` from these settings sends. */
export function hostRunSettings(
  settings: HostRunSettingsSource
): Pick<HostParams<'run/start'>, 'configuration' | 'modelId' | 'planMode'> {
  return {
    ...(settings.readConfiguration
      ? {
          configuration: z
            .record(z.string(), z.json())
            .parse(JSON.parse(JSON.stringify(settings.readConfiguration()))),
        }
      : {}),
    modelId: settings.readModelId?.() ?? settings.modelId,
    ...(settings.readPlanMode?.() ? { planMode: true as const } : {}),
  };
}

/**
 * BST-1990 (D4): the host refused the run before admitting it (its JSON-RPC
 * code says so), so nothing was committed and the user's message may be sent
 * again. The code is read structurally: the client's error class is bundled.
 */
function isRunNotAdmitted(cause: unknown): cause is Error {
  return cause instanceof Error && hostErrorCode(cause) === HOST_RUN_NOT_ADMITTED_CODE;
}

/** A host refusal's JSON-RPC code; undefined for a failure that never reached the host. */
function hostErrorCode(cause: unknown): number | undefined {
  const response = cause instanceof BoundaryFailureError ? cause.cause : cause;
  const code: unknown =
    typeof response === 'object' && response !== null && 'code' in response
      ? response.code
      : undefined;
  return typeof code === 'number' ? code : undefined;
}

/** Construct alongside the attached client, outside React render. */
export function createCommittedHostConversation(
  options: HostRunSettingsSource & {
    /**
     * Bind the thread to its folder before a run it starts, as legacy's first
     * request did (`bindHostThreadToMainRoot`); a refusal fails that send.
     */
    readonly bindThreadRoot?: () => Promise<void>;
    readonly client: HostClient;
    /** Told when a newer committed title, colour or icon reaches this view. */
    readonly onTitleCommitted?: () => void;
    readonly threadId: string;
  }
): CommittedHostConversation {
  const { client, threadId } = options;
  const source = new CommittedThreadSession(client, threadId);
  const mcpInput = new CommittedHostMcpInput(client, source, threadId);
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
  const runSettings = () => hostRunSettings(options);
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
    await options.bindThreadRoot?.();
    try {
      await client.request('run/start', {
        ...(attachments.length > 0 ? { attachments } : {}),
        commandId: crypto.randomUUID(),
        ...runSettings(),
        parentMessageId: message.parentId,
        prompt,
        threadId,
      });
    } catch (cause) {
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
  const commands: CommittedAssistantCommands = {
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
    // The vendor passes the user message being answered again.
    onReload: async (parentId) => {
      if (parentId === null) {
        throw new Error('Regenerate has no committed user message');
      }
      await options.bindThreadRoot?.();
      await client.request('run/regenerate', {
        commandId: crypto.randomUUID(),
        ...runSettings(),
        threadId,
        userMessageId: parentId,
      });
    },
    onRespondToToolApproval: async (response) => {
      const pending = store
        .getCommittedView()
        .pendingInteractions.filter(
          (interaction) => interaction.interactionId === response.approvalId
        );
      const interaction = pending[0];
      if (pending.length !== 1 || !interaction) {
        throw new Error('Approval has no unique committed interaction');
      }
      if (interaction.kind && interaction.kind !== 'approval') {
        await resumeHostInteraction(client, interaction, response);
        return;
      }
      // A grant option is committed by the host, which keeps it for the thread's tree.
      await respondToHostApproval(client, interaction, response);
    },
    // Branch selection is client view state: the vendor already moved its own
    // head over the committed tree, and nothing is written to the host.
    setMessages: () => undefined,
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
  const approvals = new HostTreeApprovals(client, threadId, source);
  const disconnect = source.connect();
  return {
    approvals,
    checkpoints: new CommittedHostCheckpoints(client, source, threadId),
    close: () => {
      releaseTelemetry();
      releaseResults();
      unsubscribeTitles();
      approvals.close().catch((error: unknown) => {
        logger.error('Delegated approvals unsubscribe failed', { error, threadId });
      });
      mcpInput.close();
      // The client outlives this view, so the unsubscribe is not joined here;
      // its refusal is reported, never swallowed.
      disconnect().catch((error: unknown) => {
        logger.error('Committed conversation unsubscribe failed', { error, threadId });
      });
      store.dispose();
    },
    commands,
    mcpInput,
    sendInput: async (input, signal) => {
      const runId = store.getCommittedView().activeRunId;
      if (!runId) {
        throw new Error('The child is not running');
      }
      signal.throwIfAborted();
      // The input's own ID is the command: an unconfirmed retry repeats it exactly.
      await client.request('run/input', {
        ...(input.attachments?.length
          ? { attachments: input.attachments.map(childImageAttachment) }
          : {}),
        commandId: input.id,
        ...runSettings(),
        prompt: input.text,
        runId,
        threadId,
      });
    },
    source,
    steer: async () => {
      const runId = store.getCommittedView().activeRunId;
      if (!runId) {
        return;
      }
      const { outcome } = await client.request('run/steer', {
        commandId: crypto.randomUUID(),
        runId,
        threadId,
      });
      return outcome === 'steering' ? runId : undefined;
    },
    store,
    verdicts: new CommittedHostVerdicts(client, source, threadId),
  };
}
