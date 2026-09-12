import {
  useAuiState,
  unstable_useThreadMessageIds as useThreadMessageIds,
} from '@assistant-ui/react';
import { type RefObject, use, useLayoutEffect } from 'react';
import { ThreadMessageNavigationContext } from './thread-message-navigation';

/** Coordinates focus; the containing renderer remains the only scroll owner. */
export function useThreadMessageNavigation({
  viewportRef,
  isVirtual,
  scrollToMatch,
}: {
  readonly viewportRef: RefObject<HTMLElement | null>;
  readonly isVirtual: boolean;
  readonly scrollToMatch: (index: number, element?: HTMLElement) => void;
}): void {
  const navigation = use(ThreadMessageNavigationContext);
  const messageIds = useThreadMessageIds();
  const isLoading = useAuiState((state) => state.thread.isLoading);
  const targetId = useAuiState((state) => {
    if (!navigation) {
      return;
    }
    return state.thread.messages.find((message) => {
      const sources = message.metadata.custom['brainstrikeNativeMessageIds'];
      return (
        message.id === navigation.messageId ||
        (Array.isArray(sources) && sources.includes(navigation.messageId))
      );
    })?.id;
  });
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!(navigation && viewport) || isLoading || navigation.isLoading) {
      return;
    }
    const index = targetId ? messageIds.indexOf(targetId) : -1;
    if (index < 0) {
      navigation.onComplete('The matched message is not in the loaded conversation history.');
      return;
    }
    const focusMessage = (): boolean => {
      const target = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]')).find(
        (row) => row.dataset['messageId'] === targetId
      );
      if (!target) {
        return false;
      }
      if (!isVirtual) {
        scrollToMatch(index, target);
      }
      target.focus({ preventScroll: true });
      navigation.onComplete();
      return true;
    };
    let active = true;
    const observer = new MutationObserver(() => {
      if (focusMessage()) {
        observer.disconnect();
      }
    });
    // Own the allocation and cleanup in this effect, including a cancelled
    // microtask or an offscreen virtual row that has not mounted yet.
    observer.observe(viewport, { childList: true, subtree: true });
    const navigate = () => {
      if (!active) {
        return;
      }
      if (isVirtual) {
        scrollToMatch(index);
      }
      if (focusMessage()) {
        observer.disconnect();
      }
    };
    if (isVirtual) {
      // TanStack synchronously flushes its range; leave React's commit first.
      queueMicrotask(navigate);
    } else {
      navigate();
    }
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [isLoading, isVirtual, messageIds, navigation, scrollToMatch, targetId, viewportRef]);
}
