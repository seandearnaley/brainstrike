import {
  type ExportedMessageRepository,
  type ExternalStoreAdapter,
  isMessageNotSentError,
  MessageNotSentError,
  type ThreadMessage,
} from '@assistant-ui/react';
import type { ThreadTokenUsage } from './context-usage-store';
import type { LiveShellOutputs } from './live-shell-outputs';

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
  /** The latest run received no observational memory, and why (a committed host reason). */
  readonly observationWithheld?: 'branched-thread' | undefined;
  readonly repository: ExportedMessageRepository;
  readonly state?: ExternalStoreAdapter['state'];
}

/** One source per conversation. Its owner folds/replays the log; this binding never appends to it. */
export interface CommittedAssistantStore {
  readonly getSnapshot: () => CommittedAssistantSnapshot;
  /** Running commands' live output, sent as uncommitted host telemetry. */
  readonly liveShellOutputs?: LiveShellOutputs | undefined;
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

/**
 * Run commands (send, edit, regenerate) the owner has dispatched and not yet
 * settled: the vendor's "submitted" state. The committed fold shows a run only
 * once the host has admitted it, and the host commits that run before it
 * answers the command, so a settled command means the fold already holds its
 * run. Until then a second composer send would reach the host as a refused
 * `run/start` (BST-1981), so the composer's sends wait for this.
 */
export class CommittedRunStarts {
  private inFlight = 0;
  private readonly listeners = new Set<() => void>();

  readonly isStarting = (): boolean => this.inFlight > 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async track(start: () => Promise<void>): Promise<void> {
    this.change(1);
    try {
      await start();
    } finally {
      this.change(-1);
    }
  }

  private change(delta: 1 | -1): void {
    const wasStarting = this.isStarting();
    this.inFlight += delta;
    if (wasStarting !== this.isStarting()) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}

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
  onCommandError: (cause: unknown) => void,
  starts: CommittedRunStarts
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
  /** A command that starts a run is in flight until the host answers it. */
  function startPort<Args extends readonly unknown[]>(
    command: (...args: Args) => Promise<void>,
    restoresDraft = false
  ): (...args: Args) => Promise<void> {
    return observedPort((...args: Args) => starts.track(() => command(...args)), restoresDraft);
  }
  const send = startPort(commands.onNew, true);
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
    onEdit: commands.onEdit ? startPort(commands.onEdit, true) : undefined,
    // The vendor import API mutates its repository even without an import port.
    // Always reject/report unsupported imports so the hook restores the fold.
    onImport: synchronousPort(
      commands.onImport ??
        (() => {
          throw new Error('The agent host does not support importing conversations.');
        })
    ),
    onNew: (message) => {
      // The composer stops sending while a run command is in flight
      // (`isSendDisabled`). Any other append in that window is held back
      // here, unsent and reported; a composer send gets its draft back.
      if (starts.isStarting()) {
        const held = new MessageNotSentError(
          'The previous message is still being sent, so this one was not sent.'
        );
        onCommandError(held);
        return Promise.reject(held);
      }
      return send(message);
    },
    onRefetchThread: commands.onRefetchThread
      ? connectedPort(store, commands.onRefetchThread)
      : undefined,
    onReload: commands.onReload ? startPort(commands.onReload) : undefined,
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
