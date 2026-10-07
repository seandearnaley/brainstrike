import {
  type ExportedMessageRepository,
  type ExternalStoreAdapter,
  isMessageNotSentError,
  MessageNotSentError,
  type ThreadMessage,
} from '@assistant-ui/react';
import type { ThreadTokenUsage } from './context-usage-store';

/** Published by the host's committed fold. Messages and parts retain the fold's identities. */
export interface CommittedAssistantSnapshot {
  readonly connection: 'connecting' | 'connected' | 'disconnected' | 'failed';
  readonly contextUsage?: ThreadTokenUsage | undefined;
  readonly error?: string | undefined;
  /** Child origins, runtime identity and other owner-provided view fields pass through unchanged. */
  readonly extras?: unknown;
  readonly isDisabled?: boolean | undefined;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly repository: ExportedMessageRepository;
  readonly state?: ExternalStoreAdapter['state'];
}

/** One source per conversation. Its owner folds/replays the log; this binding never appends to it. */
export interface CommittedAssistantStore {
  readonly getSnapshot: () => CommittedAssistantSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly threadId: string;
}

/**
 * Explicit host command ports, using the installed vendor's public signatures.
 * In particular, setMessages/onImport are commands to the owner, never renderer
 * persistence. Omit unsupported ports so shipped controls reflect capabilities.
 */
export type CommittedAssistantCommands = Pick<
  ExternalStoreAdapter<ThreadMessage>,
  | 'onNew'
  | 'onEdit'
  | 'onReload'
  | 'onCancel'
  | 'onDelete'
  | 'onImport'
  | 'onRefetchThread'
  | 'onRespondToToolApproval'
  | 'onResumeToolCall'
  | 'setMessages'
  | 'unstable_onBranchChange'
>;

function connectedPort<Args extends readonly unknown[], Result>(
  store: CommittedAssistantStore,
  command: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args: Args): Result => {
    // BST-1929: reconnect/version failures cannot dispatch a stale editable action.
    // Read at dispatch time, including callbacks retained across a disconnect.
    const snapshot = store.getSnapshot();
    if (
      snapshot.connection !== 'connected' ||
      snapshot.error !== undefined ||
      snapshot.isDisabled
    ) {
      throw new Error(snapshot.error ?? 'The agent host is unavailable.');
    }
    return command(...args);
  };
}

export function bindCommittedAssistantCommands(
  store: CommittedAssistantStore,
  commands: CommittedAssistantCommands,
  onCommandError: (cause: unknown) => void
): CommittedAssistantCommands {
  function observedPort<Args extends readonly unknown[]>(
    command: (...args: Args) => Promise<void>,
    restoresDraft = false
  ): (...args: Args) => Promise<void> {
    return async (...args: Args): Promise<void> => {
      let dispatched = false;
      try {
        await connectedPort(store, (...input: Args): Promise<void> => {
          dispatched = true;
          return command(...input);
        })(...args);
      } catch (cause: unknown) {
        // The public append/edit/Stop API returns void. Report failure instead
        // of leaving an unhandled rejection; only the fold can publish success.
        onCommandError(cause);
        // The vendor consumes this signal to restore an undispatched draft.
        // An arbitrary host failure may follow acceptance, so never turn that
        // failure into permission to resend an already admitted command.
        if (isMessageNotSentError(cause)) {
          throw cause;
        }
        if (restoresDraft && !dispatched) {
          throw new MessageNotSentError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
  }
  function synchronousPort<Args extends readonly unknown[]>(
    command: (...args: Args) => void
  ): (...args: Args) => void {
    return (...args: Args): void => {
      try {
        // TypeScript permits async functions for the vendor's void ports.
        // The vendor does not await them, so observe admission failures here.
        const result: unknown = connectedPort(store, command)(...args);
        void Promise.resolve(result).catch(onCommandError);
      } catch (cause: unknown) {
        // Branch/import mutate the vendor view before calling their port.
        // The hook resyncs that view from the canonical fold on this report.
        onCommandError(cause);
        throw cause;
      }
    };
  }
  return {
    onCancel: commands.onCancel ? observedPort(commands.onCancel) : undefined,
    onDelete: commands.onDelete ? connectedPort(store, commands.onDelete) : undefined,
    onEdit: commands.onEdit ? observedPort(commands.onEdit, true) : undefined,
    // The vendor import API mutates its repository even without an import port.
    // Always reject/report unsupported imports so the hook restores the fold.
    onImport: synchronousPort(
      commands.onImport ??
        (() => {
          throw new Error('The agent host does not support importing conversations.');
        })
    ),
    onNew: observedPort(commands.onNew, true),
    onRefetchThread: commands.onRefetchThread
      ? connectedPort(store, commands.onRefetchThread)
      : undefined,
    onReload: commands.onReload ? observedPort(commands.onReload) : undefined,
    onRespondToToolApproval: commands.onRespondToToolApproval
      ? connectedPort(store, commands.onRespondToToolApproval)
      : undefined,
    onResumeToolCall: commands.onResumeToolCall
      ? synchronousPort(commands.onResumeToolCall)
      : undefined,
    setMessages: commands.setMessages ? synchronousPort(commands.setMessages) : undefined,
    // biome-ignore lint/style/useNamingConvention: installed assistant-ui command port name.
    unstable_onBranchChange: commands.unstable_onBranchChange
      ? synchronousPort(commands.unstable_onBranchChange)
      : undefined,
  };
}

export function selectCommittedAssistantMessage(
  snapshot: CommittedAssistantSnapshot,
  messageId: string
): ThreadMessage | undefined {
  return snapshot.repository.messages.find(({ message }) => message.id === messageId)?.message;
}

export function selectCommittedAssistantPart(
  snapshot: CommittedAssistantSnapshot,
  messageId: string,
  partIndex: number
): ThreadMessage['content'][number] | undefined {
  return selectCommittedAssistantMessage(snapshot, messageId)?.content[partIndex];
}

/** Select by the host's tool-call identity, including when earlier parts were inserted. */
export function selectCommittedAssistantTool(
  snapshot: CommittedAssistantSnapshot,
  messageId: string,
  toolCallId: string
): Extract<ThreadMessage['content'][number], { type: 'tool-call' }> | undefined {
  return selectCommittedAssistantMessage(snapshot, messageId)?.content.find(
    (part): part is Extract<ThreadMessage['content'][number], { type: 'tool-call' }> =>
      part.type === 'tool-call' && part.toolCallId === toolCallId
  );
}
