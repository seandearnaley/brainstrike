import { createContext } from 'react';

/** One explicit navigation request for the containing conversation only. */
export interface ThreadMessageNavigation {
  readonly isLoading?: boolean;
  readonly messageId: string;
  readonly onComplete: (error?: string) => void;
  readonly requestId: number;
}

export const ThreadMessageNavigationContext = createContext<ThreadMessageNavigation | null>(null);
