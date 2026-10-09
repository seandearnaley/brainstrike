import { AssistantLinkCapabilitiesProvider } from '@brainstrike/assistant-ui/assistant-link-capabilities-provider';
import type { WorkspaceApp } from '@brainstrike/file-explorer-ui/shell';
import { useWorkspaceTabSelectionStore } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { isAgentColor } from '@brainstrike/types/agent-color';
import { MessageSquare } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { getDelegatedColorPresentation } from './agent-color-presentation';
import {
  type AssistantThreadHostCapability,
  type AssistantThreadHostChild,
  useAssistantThreadHost,
} from './assistant-thread-host-context';
import { CHILD_PROVIDER_SOURCE } from './delegated-child-conversation-panel';
import { Failure } from './delegated-workspace-child-view';
import { AssistantProviderSourceProvider } from './hooks/assistant-provider-source';
import { type HostChildWorkspaceTab, readHostChildWorkspaceTab } from './host-child-workspace-tab';
import { useAssistantLinkCapabilitiesValue } from './use-assistant-link-capabilities';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const MISSING = 'The child conversation is missing or does not belong to this workspace.';
const NOT_HOSTED = 'This child conversation is not owned by the agent host.';
const icon: WorkspaceApp['icon'] = ({ className }) => <MessageSquare className={className} />;

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

type Resolution =
  | { readonly child: AssistantThreadHostChild; readonly host: AssistantThreadHostCapability }
  | { readonly error: Error; readonly host: AssistantThreadHostCapability | undefined };

/**
 * A tab address is not authority: the host resolves the child from its
 * committed origin, and the address must name the persona it runs, before the
 * child presents itself or mounts (a reload restores only the address).
 */
async function resolveTab(
  host: AssistantThreadHostCapability | undefined,
  tab: HostChildWorkspaceTab
): Promise<AssistantThreadHostChild> {
  if (!host?.resolveChildThread) {
    throw new Error(NOT_HOSTED);
  }
  const child = await host.resolveChildThread(tab.threadId);
  if (child.persona !== tab.persona) {
    throw new Error(MISSING);
  }
  return child;
}

function tabAppearance(color: string): NonNullable<WorkspaceApp['tabAppearance']> {
  if (!isAgentColor(color)) {
    throw new Error('The child conversation colour is not an agent colour.');
  }
  const appearance = getDelegatedColorPresentation(color);
  return {
    accentClassName: appearance.accentClassName,
    colorId: color,
    idleClassName: appearance.idleClassName,
    markClassName: appearance.markClassName,
    selectedClassName: appearance.selectedClassName,
    style: appearance.style,
  };
}

function hostChildApp(
  id: string,
  tab: HostChildWorkspaceTab,
  resolution: Resolution | undefined
): WorkspaceApp {
  if (resolution && 'child' in resolution) {
    const { child, host } = resolution;
    return {
      icon,
      id,
      label: child.callSign,
      placement: 'dynamic',
      render: () => (
        <HostChildSurface>
          {host.renderThread(tab.threadId, true) ?? <Failure error={new Error(NOT_HOSTED)} />}
        </HostChildSurface>
      ),
      tabAppearance: tabAppearance(child.color),
    };
  }
  return {
    icon,
    id,
    label: 'Child conversation',
    placement: 'dynamic',
    render: () =>
      resolution ? (
        <Failure error={resolution.error} />
      ) : (
        <p className="p-4" role="status">
          Loading conversation…
        </p>
      ),
  };
}

/**
 * BST-1932: an open agent host child thread is a dynamic workspace tab that
 * shows the host's own thread view for that child: its transcript, composer,
 * Stop and approvals all act on the child thread. It is named and tinted by
 * the child's call sign and family colour, as the host derives them.
 */
export function useHostChildWorkspaceApps(): readonly WorkspaceApp[] {
  const host = useAssistantThreadHost();
  const openIds = useWorkspaceTabSelectionStore((state) => state.openAppIds);
  const addresses = useMemo(
    () =>
      openIds.flatMap(
        (id): { readonly id: string; readonly tab: HostChildWorkspaceTab | Error }[] => {
          try {
            const tab = readHostChildWorkspaceTab(id);
            return tab ? [{ id, tab }] : [];
          } catch (error) {
            return [{ id, tab: asError(error) }];
          }
        }
      ),
    [openIds]
  );
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, Resolution>>(() => new Map());
  // Each address resolves once per host; a later host's answer replaces it.
  const requested = useRef(new Map<string, AssistantThreadHostCapability | undefined>());
  const currentHost = useRef(host);
  useEffect(() => {
    currentHost.current = host;
    for (const { id, tab } of addresses) {
      if (
        tab instanceof Error ||
        (requested.current.has(id) && requested.current.get(id) === host)
      ) {
        continue;
      }
      requested.current.set(id, host);
      const settle = (resolution: Resolution): void => {
        if (currentHost.current === resolution.host) {
          setResolutions((previous) => new Map(previous).set(id, resolution));
        }
      };
      resolveTab(host, tab).then(
        (child) => settle(host ? { child, host } : { error: new Error(NOT_HOSTED), host }),
        (error: unknown) => settle({ error: asError(error), host })
      );
    }
  }, [addresses, host]);
  return useMemo(
    () =>
      addresses.map(({ id, tab }): WorkspaceApp => {
        if (tab instanceof Error) {
          return {
            icon,
            id,
            label: 'Child conversation',
            placement: 'dynamic',
            render: () => <Failure error={tab} />,
          };
        }
        const resolution = resolutions.get(id);
        return hostChildApp(id, tab, resolution?.host === host ? resolution : undefined);
      }),
    [addresses, host, resolutions]
  );
}
