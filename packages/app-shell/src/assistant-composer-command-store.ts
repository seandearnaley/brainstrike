import { createLogger } from '@brainstrike/logging';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

const logger = createLogger('AssistantComposerDrafts');

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

function isDraftRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((text) => typeof text === 'string')
  );
}

export const useAssistantComposerCommandStore = create<AssistantComposerCommandState>()(
  persist(
    (set) => ({
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
    }),
    {
      merge: (persisted, current) => {
        if (persisted === undefined) {
          return current;
        }
        if (
          !(
            persisted &&
            typeof persisted === 'object' &&
            'draftTextByThreadId' in persisted &&
            isDraftRecord(persisted.draftTextByThreadId)
          )
        ) {
          throw new Error('Stored composer drafts are invalid.');
        }
        const { draftTextByThreadId } = persisted;
        return {
          ...current,
          commandsByThreadId: Object.fromEntries(
            Object.entries(draftTextByThreadId)
              .filter(([, text]) => text.trim())
              .map(([threadId, text]) => [
                threadId,
                [
                  {
                    id: crypto.randomUUID(),
                    mode: 'replace' as const,
                    text,
                    threadId,
                  },
                ],
              ])
          ),
          draftTextByThreadId,
        };
      },
      name: 'assistant-composer-drafts.v1',
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          logger.error('Failed to restore saved composer drafts', { error });
        }
      },
      partialize: (state) => ({ draftTextByThreadId: state.draftTextByThreadId }),
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);
