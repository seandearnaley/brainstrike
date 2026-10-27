import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { parseCanvasLink } from '@brainstrike/assistant-contract';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { AssistantLinkCapabilities } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useMemo } from 'react';
import { openCanvasTab } from './canvas/open-canvas-tab';
import { type OpenLinkResult, openExternalLink } from './open-external-link';

const MAX_TOASTED_URL_LENGTH = 120;
const logger = createLogger('AssistantLinkCapabilities');

/** Model-authored URLs are untrusted and can be arbitrarily long; a toast is
 * not the place to render one in full. */
function truncate(url: string): string {
  return url.length > MAX_TOASTED_URL_LENGTH ? `${url.slice(0, MAX_TOASTED_URL_LENGTH)}…` : url;
}

/**
 * Report a link failure to the user.
 *
 * Without this the click is indistinguishable from the bug being fixed:
 * something the user clicked, and nothing happened. The REASON matters too —
 * "unsupported protocol" and "the shell failed" call for different reactions,
 * and the URL alone distinguishes neither.
 */
function reportFailure(result: OpenLinkResult, url: string): void {
  try {
    toast({
      // Joined rather than interpolated: a sanitized-away href arrives here as
      // '', and "<reason> — " with nothing after it reads like a rendering bug
      // rather than an explanation.
      description: [result.error, truncate(url)].filter(Boolean).join(' — '),
      title: 'Could not open link',
      variant: 'destructive',
    });
  } catch (error) {
    // `openLink` promises never to reject, and that has to hold even when the
    // only thing left to fail is the failure reporter itself.
    logger.error('Failed to surface a link failure to the user', { error, url });
  }
}

/**
 * `canvas://<canvasId>` opens IN the app: open/activate that canvas's own
 * workspace tab on the active thread, and bring the shell back to the explorer
 * route (the workspace panel only exists there — the same two-step pairing
 * `useChangesReviewValue` does for the "→ Review" link). `null` means "not a
 * canvas link", so the caller falls through to the external policy; a
 * malformed canvas link is a visible failure, never a fall-through that would
 * toast the true-but-useless "Blocked protocol: canvas:".
 */
function openCanvasLink(url: string): OpenLinkResult | null {
  const parsed = parseCanvasLink(url);
  if (parsed.kind === 'not-canvas') {
    return null;
  }
  if (parsed.kind === 'malformed') {
    return { error: parsed.error, ok: false };
  }
  const threadId =
    useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID];
  if (!threadId) {
    return { error: 'Open the canvas from its thread', ok: false };
  }
  openCanvasTab({ canvasId: parsed.canvasId, threadId });
  usePanelLayoutStore.getState().setActiveTab('explorer');
  return { ok: true };
}

/**
 * The host half of the assistant panel's link seam.
 *
 * The panel decides only that a link was activated; this decides where it goes
 * and is the ONE place a link failure becomes visible — the same division of
 * labour the workspace-bar chips use. Every http/https/mailto link goes to the
 * OS browser; `canvas://` links open the canvas's workspace tab in-app. When the
 * in-app browser pane ships, the routing choice belongs here, and
 * `packages/assistant-ui` does not change.
 */
export function useAssistantLinkCapabilitiesValue(): AssistantLinkCapabilities {
  return useMemo<AssistantLinkCapabilities>(
    () => ({
      openLink: async (url: string): Promise<OpenLinkResult> => {
        const canvas = openCanvasLink(url);
        const result = canvas ?? (await openExternalLink(url));
        if (!result.ok) {
          reportFailure(result, url);
        }
        return result;
      },
    }),
    []
  );
}
