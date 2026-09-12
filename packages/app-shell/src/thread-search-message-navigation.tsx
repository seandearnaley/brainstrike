import { ThreadMessageNavigationContext } from '@brainstrike/assistant-ui';
import type { ReactNode } from 'react';
import { useThreadSearchStore } from './thread-search-store';

export function ThreadSearchMessageNavigation({
  ownerResourceId,
  threadId,
  children,
  isLoading,
}: {
  readonly ownerResourceId: string;
  readonly threadId: string | null | undefined;
  readonly isLoading?: boolean;
  readonly children: ReactNode;
}) {
  const target = useThreadSearchStore((state) => state.navigationTarget);
  const selected = target?.ownerResourceId === ownerResourceId && target.threadId === threadId;
  return (
    <ThreadMessageNavigationContext
      value={
        selected
          ? {
              isLoading: isLoading ?? false,
              messageId: target.messageId,
              onComplete: (error) =>
                useThreadSearchStore.getState().finishNavigation(target.requestId, error),
              requestId: target.requestId,
            }
          : null
      }
    >
      {children}
    </ThreadMessageNavigationContext>
  );
}
