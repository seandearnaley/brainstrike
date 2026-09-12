import type { ThreadMessageNavigation } from '@brainstrike/assistant-ui';
import { ThreadMessageNavigationContext } from '@brainstrike/assistant-ui';
import { type ReactNode, useMemo } from 'react';
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
  const navigation = useMemo<ThreadMessageNavigation | null>(
    () =>
      selected
        ? {
            isLoading: isLoading ?? false,
            messageId: target.messageId,
            onComplete: (error) =>
              useThreadSearchStore.getState().finishNavigation(target.requestId, error),
            requestId: target.requestId,
          }
        : null,
    [isLoading, selected, target]
  );
  return (
    <ThreadMessageNavigationContext value={navigation}>{children}</ThreadMessageNavigationContext>
  );
}
