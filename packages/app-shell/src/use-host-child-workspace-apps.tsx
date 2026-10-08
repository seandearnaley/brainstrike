import { personaLabelForToolName } from '@brainstrike/assistant-ui';
import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { MessageSquare } from 'lucide-react';
import { type ReactNode, useMemo } from 'react';
import { useAssistantThreadHost } from './assistant-thread-host-context';
import { CHILD_PROVIDER_SOURCE } from './delegated-child-conversation-panel';
import { Failure } from './delegated-workspace-child-view';
import { AssistantProviderSourceProvider } from './hooks/assistant-provider-source';
import { readHostChildWorkspaceTab } from './host-child-workspace-tab';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The assistant panel's own providers, as a legacy child conversation receives them. */
function HostChildSurface({ children }: { readonly children: ReactNode }) {
  const linkCapabilities = useAssistantLinkCapabilitiesValue();
  return (
    <AssistantProviderSourceProvider source={CHILD_PROVIDER_SOURCE}>
      <AssistantLinkCapabilitiesProvider capabilities={linkCapabilities}>
        {children}
      </AssistantLinkCapabilitiesProvider>
    </AssistantProviderSourceProvider>
  );
}

/**
 * BST-1932: an open agent host child thread is a dynamic workspace tab that
 * shows the host's own thread view for that child: its transcript, composer,
 * Stop and approvals all act on the child thread.
 */
export function useHostChildWorkspaceApps(): readonly WorkspaceApp[] {
  const host = useAssistantThreadHost();
  const openIds = useWorkspaceTabSelectionStore((state) => state.openAppIds);
  return useMemo(
    () =>
      openIds.flatMap((id): WorkspaceApp[] => {
        let tab: ReturnType<typeof readHostChildWorkspaceTab>;
        try {
          tab = readHostChildWorkspaceTab(id);
        } catch (error) {
          return [
            {
              icon: ({ className }) => <MessageSquare className={className} />,
              id,
              label: 'Child conversation',
              placement: 'dynamic',
              render: () => <Failure error={asError(error)} />,
            },
          ];
        }
        if (!tab) {
          return [];
        }
        const { persona, threadId } = tab;
        return [
          {
            icon: ({ className }) => <MessageSquare className={className} />,
            id,
            label: personaLabelForToolName(`agent-${persona}`),
            placement: 'dynamic',
            render: () => (
              <HostChildSurface>
                {host?.renderThread(threadId, true) ?? (
                  <Failure
                    error={new Error('This child conversation is not owned by the agent host.')}
                  />
                )}
              </HostChildSurface>
            ),
          },
        ];
      }),
    [host, openIds]
  );
}
