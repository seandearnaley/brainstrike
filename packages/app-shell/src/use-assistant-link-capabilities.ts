import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { parseCanvasLink } from '@brainstrike/assistant-contract';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { AssistantLinkCapabilities } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import { useMemo } from 'react';
import { openCanvasTab } from './canvas/open-canvas-tab';
import { resolveLinkChoices } from './link-choices';
import { reportLinkFailure } from './link-failure';
import { type OpenLinkResult, openExternalLink } from './open-external-link';

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
 * labour the workspace-bar chips use. `openLink` sends http/https/mailto links
 * to the OS browser and opens `canvas://` links in the canvas's workspace tab.
 * With the built-in browser, a web link also offers that browser or the
 * clipboard (`linkChoices`). Its menu can drop over a browser page in the
 * workspace, so it reports opening and closing to `onMenuOpenChange`, the
 * workspace's menu count, and the page hides while it is open.
 */
export function useAssistantLinkCapabilitiesValue(
  onMenuOpenChange?: (open: boolean) => void
): AssistantLinkCapabilities {
  return useMemo<AssistantLinkCapabilities>(() => {
    const choices = resolveLinkChoices();
    return {
      linkChoices: choices ? { ...choices, onMenuOpenChange } : undefined,
      openLink: async (url: string): Promise<OpenLinkResult> => {
        const canvas = openCanvasLink(url);
        const result = canvas ?? (await openExternalLink(url));
        if (!result.ok) {
          reportLinkFailure('Could not open link', result, url);
        }
        return result;
      },
    };
  }, [onMenuOpenChange]);
}
