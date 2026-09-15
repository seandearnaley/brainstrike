import {
  useAuiState,
  unstable_useThreadMessageIds as useThreadMessageIds,
} from '@assistant-ui/react';
import { NATIVE_MESSAGE_IDS_METADATA_KEY } from '@brainstrike/assistant-contract';
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
      const sources = message.metadata.custom[NATIVE_MESSAGE_IDS_METADATA_KEY];
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
    const focusMessage = (): boolean => {
      const escapedId = targetId ? CSS.escape(targetId) : undefined;
      const target = escapedId
        ? viewport.querySelector<HTMLElement>(`[data-message-id="${escapedId}"]`)
        : null;
      if (!target) {
        return false;
      }
      try {
        if (!isVirtual) {
          scrollToMatch(index, target);
        }
        target.focus({ preventScroll: true });
        navigation.onComplete();
      } catch (error) {
        navigation.onComplete(error instanceof Error ? error.message : String(error));
      }
      return true;
    };
    let active = true;
    // A navigation must settle even if a virtual row never mounts. This is an
    // error boundary for explicit focus, not a delay on successful navigation.
    const deadline = window.setTimeout(() => {
      observer.disconnect();
      navigation.onComplete(
        index < 0
          ? 'The matched message is not in the loaded conversation history.'
          : 'The matched message could not be displayed.'
      );
    }, 2000);
    const observer = new MutationObserver(() => {
      if (focusMessage()) {
        observer.disconnect();
        window.clearTimeout(deadline);
      }
    });
    // Own the allocation and cleanup in this effect, including a cancelled
    // microtask or an offscreen virtual row that has not mounted yet.
    observer.observe(viewport, { childList: true, subtree: true });
    const navigate = () => {
      if (!active) {
        return;
      }
      if (isVirtual && index >= 0) {
        try {
          scrollToMatch(index);
        } catch (error) {
          window.clearTimeout(deadline);
          observer.disconnect();
          navigation.onComplete(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      if (focusMessage()) {
        observer.disconnect();
        window.clearTimeout(deadline);
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
      window.clearTimeout(deadline);
      observer.disconnect();
    };
  }, [isLoading, isVirtual, messageIds, navigation, scrollToMatch, targetId, viewportRef]);
}
