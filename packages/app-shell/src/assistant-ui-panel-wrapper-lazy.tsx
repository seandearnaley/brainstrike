import { type ComponentType, memo, useEffect, useState } from 'react';
import { AssistantPanelLoadingState } from './assistant-panel-loading-state';
import type { AssistantThreadTabsWorkspaceProps } from './assistant-thread-tabs-workspace';
import { createRetryableLazyModuleLoader } from './retryable-lazy-module-loader';

type AssistantThreadTabsWorkspaceModule = typeof import('./assistant-thread-tabs-workspace');
type AssistantUiPanelWrapperComponent = ComponentType<AssistantThreadTabsWorkspaceProps>;

let assistantUiPanelWrapperComponent: AssistantUiPanelWrapperComponent | null = null;
const assistantUiPanelWrapperModuleLoader =
  createRetryableLazyModuleLoader<AssistantThreadTabsWorkspaceModule>(
    () => import('./assistant-thread-tabs-workspace')
  );

function loadAssistantUiPanelWrapperModule(): Promise<AssistantThreadTabsWorkspaceModule> {
  return assistantUiPanelWrapperModuleLoader.load();
}

function getLoadedAssistantUiPanelWrapper(): AssistantUiPanelWrapperComponent | null {
  return assistantUiPanelWrapperComponent;
}

export function preloadAssistantUiPanelWrapper(): Promise<void> {
  return loadAssistantUiPanelWrapperModule().then((module) => {
    assistantUiPanelWrapperComponent = module.AssistantThreadTabsWorkspace;
  });
}

export const AssistantUiPanelWrapperLazy = memo(function AssistantUiPanelWrapperLazy(
  props: AssistantThreadTabsWorkspaceProps
) {
  const [LoadedComponent, setLoadedComponent] = useState<AssistantUiPanelWrapperComponent | null>(
    () => getLoadedAssistantUiPanelWrapper()
  );
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    if (LoadedComponent) {
      return;
    }

    let active = true;
    loadAssistantUiPanelWrapperModule()
      .then((module) => {
        if (!active) {
          return;
        }
        assistantUiPanelWrapperComponent = module.AssistantThreadTabsWorkspace;
        setLoadedComponent(() => module.AssistantThreadTabsWorkspace);
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setLoadError(error instanceof Error ? error : new Error(String(error)));
      });

    return () => {
      active = false;
    };
  }, [LoadedComponent]);

  if (loadError) {
    return (
      <div className="p-4 text-destructive text-xs" data-testid="assistant-ui-load-error">
        Failed to load assistant UI: {loadError.message}
      </div>
    );
  }

  if (!LoadedComponent) {
    return <AssistantPanelLoadingState label="Loading assistant…" />;
  }

  return <LoadedComponent {...props} />;
});
