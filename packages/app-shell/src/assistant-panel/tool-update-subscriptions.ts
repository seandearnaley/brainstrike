/**
 * The assistant's selection write-back bridge, as one subscription.
 *
 * BST-1652: this was four copy-pasted `useEffect`s in
 * `assistant-ui-panel-wrapper.tsx`, each repeating the same
 * typeof-window/capability probe, the same subscribe call and the same
 * optional-unsubscribe cleanup. Four identical shapes is four places to forget
 * a cleanup; the channel list is now data.
 *
 * Capability-gated, never `isElectron()`: a channel the preload does not expose
 * is simply not subscribed (web has no `window.tools` at all).
 */

import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';

/** Channels whose payload is (or widens to) a selection update. */
const SELECTION_CHANNELS = [
  'onRootTreeSelectionUpdate',
  'onPreviewContextSelectionUpdate',
  'onWorkspaceContextSelectionUpdate',
] as const;

export interface AssistantToolUpdateHandlers {
  readonly onSelectionUpdate: (
    payload: AssistantSelectionUpdatePayload | AssistantWorkspaceContextSelectionUpdatePayload
  ) => void;
  readonly onTapestryUpdate: (payload: AssistantWorkspaceTapestryUpdatePayload) => void;
}

/**
 * Subscribe every available assistant tool-update channel.
 *
 * Returns one disposer that unsubscribes whatever actually subscribed — safe to
 * call when nothing did.
 */
export function subscribeAssistantToolUpdates(handlers: AssistantToolUpdateHandlers): () => void {
  if (typeof window === 'undefined') {
    return () => {
      // Nothing subscribed: no window (SSR / node test env).
    };
  }

  const tools = window.tools;
  const disposers: (() => void)[] = [];

  for (const channel of SELECTION_CHANNELS) {
    const subscribe = tools?.[channel];
    if (!subscribe) {
      continue;
    }
    // Both selection payload shapes are accepted by `onSelectionUpdate`, so the
    // narrower per-channel callback types are satisfied by the same handler.
    const unsubscribe = subscribe((payload) => {
      handlers.onSelectionUpdate(payload);
    });
    if (unsubscribe) {
      disposers.push(unsubscribe);
    }
  }

  const subscribeTapestry = tools?.onWorkspaceContextTapestryUpdate;
  if (subscribeTapestry) {
    const unsubscribe = subscribeTapestry((payload) => {
      handlers.onTapestryUpdate(payload);
    });
    if (unsubscribe) {
      disposers.push(unsubscribe);
    }
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
