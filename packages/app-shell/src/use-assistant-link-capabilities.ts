import type { AssistantLinkCapabilities } from '@brainstrike/assistant-ui';
import { toast } from '@brainstrike/ui';
import { useMemo } from 'react';
import { type OpenLinkResult, openExternalLink } from './open-external-link';

/**
 * The host half of the assistant panel's link seam.
 *
 * The panel decides only that a link was activated; this decides where it goes
 * and is the ONE place a link failure becomes visible — the same division of
 * labour the workspace-bar chips use. Today every supported link goes to the OS
 * browser. When the in-app browser pane ships, the routing choice belongs here,
 * and `packages/assistant-ui` does not change.
 */
export function useAssistantLinkCapabilitiesValue(): AssistantLinkCapabilities {
  return useMemo<AssistantLinkCapabilities>(
    () => ({
      openLink: async (url: string): Promise<OpenLinkResult> => {
        const result = await openExternalLink(url);
        if (!result.ok) {
          // Without this the click is indistinguishable from the bug being
          // fixed: something the user clicked, and nothing happened.
          toast({
            description: url,
            title: 'Could not open link',
            variant: 'destructive',
          });
        }
        return result;
      },
    }),
    []
  );
}
