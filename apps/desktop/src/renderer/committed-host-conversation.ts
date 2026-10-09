import type { AppendMessage } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import {
  type HostImageAttachment,
  HostImageAttachmentSchema,
  type HostLogRow,
} from '@brainstrike/agent-host/protocol';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantChildAttachment,
  AssistantChildInput,
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

/** Construct alongside the attached client, outside React render. */
export function createCommittedHostConversation(options: {
  readonly client: HostClient;
  readonly modelId: string;
  /** Told when a newer committed title, colour or icon reaches this view. */
  readonly onTitleCommitted?: () => void;
  readonly readModelId?: () => string;
  readonly readConfiguration?: () => Record<string, unknown>;
  /** Plan mode for the next run this view starts; absent is off. */
  readonly readPlanMode?: () => boolean;
  readonly threadId: string;
}): CommittedHostConversation {
  const { client, modelId, threadId } = options;
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
  // A tool's live output and the model's live text and reasoning; each consumer
  // takes only its own chunk types.
  const releaseTelemetry = client.onTelemetry((telemetry) => {
    if (telemetry.threadId === threadId) {
      liveShellOutputs.accept(telemetry.chunk);
      store.acceptTelemetry(telemetry.runId, telemetry.chunk);
    }
  });
  const runSettings = () => ({
    ...(options.readConfiguration
      ? {
          configuration: z
            .record(z.string(), z.json())
            .parse(JSON.parse(JSON.stringify(options.readConfiguration()))),
        }
      : {}),
    modelId: options.readModelId?.() ?? modelId,
    ...(options.readPlanMode?.() ? { planMode: true as const } : {}),
  });
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
    await client.request('run/start', {
      ...(attachments.length > 0 ? { attachments } : {}),
      commandId: crypto.randomUUID(),
      ...runSettings(),
      parentMessageId: message.parentId,
      prompt,
      threadId,
    });
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
