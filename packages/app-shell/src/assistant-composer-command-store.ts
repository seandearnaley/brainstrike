import { create } from 'zustand';

export type ComposerDraftMode = 'append' | 'replace';

export interface AssistantComposerCommand {
  readonly id: string;
  readonly mode: ComposerDraftMode;
  readonly text: string;
  readonly threadId: string;
}

interface EnqueueAssistantComposerCommand {
  readonly mode: ComposerDraftMode;
  readonly text: string;
  readonly threadId: string;
}

interface AssistantComposerCommandState {
  readonly acknowledge: (threadId: string, commandId: string) => void;
  readonly commandsByThreadId: Record<string, AssistantComposerCommand[]>;
  readonly draftTextByThreadId: Record<string, string>;
  readonly enqueue: (input: EnqueueAssistantComposerCommand) => AssistantComposerCommand;
  readonly recordDraft: (threadId: string, text: string) => void;
  readonly reset: () => void;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

export const useAssistantComposerCommandStore = create<AssistantComposerCommandState>((set) => ({
  acknowledge: (threadId, commandId) => {
    set((state) => {
      const commands = state.commandsByThreadId[threadId];
      if (!commands?.some((command) => command.id === commandId)) {
        return state;
      }

      const remainingCommands = commands.filter((command) => command.id !== commandId);
      return {
        commandsByThreadId:
          remainingCommands.length > 0
            ? { ...state.commandsByThreadId, [threadId]: remainingCommands }
            : withoutKey(state.commandsByThreadId, threadId),
      };
    });
  },
  commandsByThreadId: {},
  draftTextByThreadId: {},
  enqueue: (input) => {
    if (!input.threadId.trim()) {
      throw new Error('Assistant composer commands require a thread id.');
    }
    if (!input.text.trim()) {
      throw new Error('Assistant composer commands require non-whitespace text.');
    }

    const command: AssistantComposerCommand = {
      id: crypto.randomUUID(),
      mode: input.mode,
      text: input.text,
      threadId: input.threadId,
    };
    set((state) => ({
      commandsByThreadId: {
        ...state.commandsByThreadId,
        [input.threadId]: [...(state.commandsByThreadId[input.threadId] ?? []), command],
      },
    }));
    return command;
  },
  recordDraft: (threadId, text) => {
    if (!threadId.trim()) {
      throw new Error('Assistant composer drafts require a thread id.');
    }
    set((state) => ({
      draftTextByThreadId: {
        ...state.draftTextByThreadId,
        [threadId]: text,
      },
    }));
  },
  reset: () => {
    set({ commandsByThreadId: {}, draftTextByThreadId: {} });
  },
}));
