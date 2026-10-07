import type { HostClient } from '@brainstrike/agent-host/browser';
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import { CommittedThreadSession } from '@brainstrike/agent-host/thread-view';
import {
  type CommittedAssistantCommands,
  CommittedAssistantLogStore,
} from '@brainstrike/assistant-ui';

export interface CommittedHostConversation {
  /** Release this view's subscription; the client/root host belongs to its caller. */
  close(): void;
  readonly commands: CommittedAssistantCommands;
  readonly store: CommittedAssistantLogStore;
}

/** Construct alongside the attached client, outside React render. */
export function createCommittedHostConversation(options: {
  readonly client: HostClient;
  readonly modelId: string;
  readonly readModelId?: () => string;
  readonly threadId: string;
}): CommittedHostConversation {
  const { client, modelId, threadId } = options;
  const source = new CommittedThreadSession(client, threadId);
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
  const commands: CommittedAssistantCommands = {
    onCancel: async () => {
      const runId = store.getCommittedView().activeRunId;
      if (!runId) {
        throw new Error('Stop has no committed active root run');
      }
      await client.request('run/stop', { commandId: crypto.randomUUID(), runId, threadId });
    },
    onNew: async (message) => {
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
        modelId: options.readModelId?.() ?? modelId,
        prompt,
        threadId,
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
      await client.request('interaction/respond', {
        commandId: crypto.randomUUID(),
        decision: response.approved ? 'approve' : 'deny',
        interactionId: interaction.interactionId,
        runId: interaction.runId,
        threadId,
      });
    },
  };
  const disconnect = source.connect();
  return {
    close: () => {
      disconnect();
      store.dispose();
    },
    commands,
    store,
  };
}
