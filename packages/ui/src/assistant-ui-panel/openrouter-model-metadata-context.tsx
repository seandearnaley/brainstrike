import type { OpenRouterModelMetadataLookup } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, use } from 'react';
import { AssistantDetailLevelProvider } from './assistant-detail-level-context';

const OpenRouterModelMetadataContext = createContext<OpenRouterModelMetadataLookup | undefined>(
  undefined
);

export function AssistantPanelMetadataProviders({
  children,
  value,
}: {
  readonly children: ReactNode;
  readonly value: OpenRouterModelMetadataLookup | undefined;
}) {
  return (
    <AssistantDetailLevelProvider>
      <OpenRouterModelMetadataContext.Provider value={value}>
        {children}
      </OpenRouterModelMetadataContext.Provider>
    </AssistantDetailLevelProvider>
  );
}

export function useOpenRouterModelMetadataLookup(): OpenRouterModelMetadataLookup | undefined {
  return use(OpenRouterModelMetadataContext);
}
