import { MessageNotSentError } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  type HostImageAttachment,
  HostImageAttachmentSchema,
  type HostParams,
} from '@brainstrike/agent-host/protocol';
import type { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantChildAttachment,
  AssistantChildInput,
} from '@brainstrike/assistant-contract';
import type {
  CommittedAssistantCommands,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';
import {
  committedConversationIdentity,
  createCommittedHostThread,
} from '@brainstrike/host-conversation';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { CommittedHostCheckpoints } from './committed-host-checkpoints';
import { CommittedHostMcpInput } from './committed-host-mcp-input';
import { CommittedHostVerdicts } from './committed-host-verdicts';
import { respondToHostApproval, resumeHostInteraction } from './host-approval-response';
import { HostTreeApprovals } from './host-tree-approvals';

const logger = createLogger('CommittedHostConversation');

/** BST-2004: the lost host's replacement has no record of the send. */
export const HOST_RESTARTED_NOT_SENT = 'Not sent: the agent host restarted.';

/** The view's message identities for a committed run (`@brainstrike/host-conversation`). */
export { committedConversationIdentity };

/** A child input's image as the host's user-message attachment; anything else is refused. */
function childImageAttachment(attachment: AssistantChildAttachment): HostImageAttachment {
  return HostImageAttachmentSchema.parse({
    data: attachment.data,
    mediaType: attachment.mediaType.toLowerCase(),
    name: attachment.filename,
    type: 'image',
  });
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
    /**
     * BST-2004: the frame's next client after this one is lost. A send the
     * lost host never answered is settled from that host's committed log.
     */
    readonly replacement?: (lost: HostClient) => Promise<HostClient>;
    readonly threadId: string;
  }
): CommittedHostConversation {
  const { client, replacement, threadId } = options;
  const runSettings = () => hostRunSettings(options);
  const thread = createCommittedHostThread({
    ...(options.bindThreadRoot ? { beforeStart: options.bindThreadRoot } : {}),
    client,
    ...(options.onTitleCommitted ? { onTitleCommitted: options.onTitleCommitted } : {}),
    runSettings,
    // BST-2004: a send whose host was lost before it answered, or before the
    // send left, is settled from the replacement's committed log. Only that log
    // says whether the turn was admitted; nothing is resent.
    ...(replacement
      ? {
          settleLost: async (commandId: string) => {
            const next = await replacement(client);
            const { rows } = await next.request('thread/read', { fromSeq: 0, threadId });
            if (
              !rows.some(
                ({ event }) => event.type === 'command.accepted' && event.commandId === commandId
              )
            ) {
              throw new MessageNotSentError(HOST_RESTARTED_NOT_SENT);
            }
          },
        }
      : {}),
    threadId,
  });
  const { source, store } = thread;
  const mcpInput = new CommittedHostMcpInput(client, source, threadId);
  const commands: CommittedAssistantCommands = {
    ...thread.commands,
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
  };
  const approvals = new HostTreeApprovals(client, threadId, source);
  // Every part of the view subscribes before the session's replay.
  thread.connect();
  return {
    approvals,
    checkpoints: new CommittedHostCheckpoints(client, source, threadId),
    close: () => {
      approvals.close().catch((error: unknown) => {
        logger.error('Delegated approvals unsubscribe failed', { error, threadId });
      });
      mcpInput.close();
      thread.close();
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
