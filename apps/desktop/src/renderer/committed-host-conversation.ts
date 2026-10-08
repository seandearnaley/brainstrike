import type { AppendMessage } from '@assistant-ui/react';
import type { HostClient } from '@brainstrike/agent-host/browser';
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  type CommittedAssistantCommands,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { CommittedHostMcpInput } from './committed-host-mcp-input';

const logger = createLogger('CommittedHostConversation');

export interface CommittedHostConversation {
  /** Release this view's subscription; the client/root host belongs to its caller. */
  close(): void;
  readonly commands: CommittedAssistantCommands;
  readonly mcpInput: CommittedHostMcpInput;
  readonly store: CommittedAssistantLogStore;
}

/** Construct alongside the attached client, outside React render. */
export function createCommittedHostConversation(options: {
  readonly client: HostClient;
  readonly modelId: string;
  readonly readModelId?: () => string;
  readonly readConfiguration?: () => Record<string, unknown>;
  readonly threadId: string;
}): CommittedHostConversation {
  const { client, modelId, threadId } = options;
  const source = new CommittedThreadSession(client, threadId);
  const mcpInput = new CommittedHostMcpInput(client, source, threadId);
  const store = new CommittedAssistantLogStore({
    identifyRun: (row) => {
      const runId = row.event['runId'];
      if (typeof runId !== 'string') {
        throw new Error('Committed conversation has no run identity');
      }
      return committedRunIdentity(source.getSnapshot().rows, runId);
    },
    source,
    threadId,
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
  });
  // A send, a send from a selected branch, and an edit all start a new user
  // message after the vendor's explicit parent (null: the thread root).
  const startTurn = async (message: AppendMessage): Promise<void> => {
    if (
      (message.attachments?.length ?? 0) > 0 ||
      message.content.some((part) => part.type !== 'text')
    ) {
      throw new Error('This host command requires text input');
    }
    const prompt = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    await client.request('run/start', {
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
        if (response.text === undefined) {
          throw new Error('Human interaction requires its typed response');
        }
        await client.request('interaction/resume', {
          commandId: crypto.randomUUID(),
          interactionId: interaction.interactionId,
          resumeData: z.json().parse(JSON.parse(response.text)),
          runId: interaction.runId,
          threadId,
        });
        return;
      }
      await client.request('interaction/respond', {
        commandId: crypto.randomUUID(),
        decision: response.approved ? 'approve' : 'deny',
        interactionId: interaction.interactionId,
        runId: interaction.runId,
        threadId,
      });
    },
    // Branch selection is client view state: the vendor already moved its own
    // head over the committed tree, and nothing is written to the host.
    setMessages: () => undefined,
  };
  const disconnect = source.connect();
  return {
    close: () => {
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
    store,
  };
}
