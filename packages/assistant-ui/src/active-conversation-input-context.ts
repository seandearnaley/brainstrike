import { createContext, use } from 'react';

export type SendActiveConversationInput = (
  input: {
    readonly id: string;
    readonly text: string;
  },
  signal: AbortSignal
) => Promise<void>;
interface ActiveInputControl {
  readonly busy: boolean;
  readonly discard: () => void;
  readonly error?: string | undefined;
  readonly send: () => Promise<void>;
  readonly stopWaiting: () => void;
}
export const ActiveInputContext = createContext<ActiveInputControl | undefined>(undefined);

export function useActiveConversationInput(): ActiveInputControl | undefined {
  return use(ActiveInputContext);
}
