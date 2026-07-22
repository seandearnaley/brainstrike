import type { OpenRouterModelMetadataLookup } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, use } from 'react';
import { AssistantDetailLevelProvider } from './assistant-detail-level-context';

const OpenRouterModelMetadataContext = createContext<OpenRouterModelMetadataLookup | undefined>(
  undefined
);
const ProviderSettingsValidationContext = createContext<
  ((reason: string | undefined) => void) | undefined
>(undefined);

export function AssistantPanelMetadataProviders({
  children,
  onProviderSettingsValidationChange,
  value,
}: {
  readonly children: ReactNode;
  readonly onProviderSettingsValidationChange?: ((reason: string | undefined) => void) | undefined;
  readonly value: OpenRouterModelMetadataLookup | undefined;
}) {
  return (
    <AssistantDetailLevelProvider>
      <ProviderSettingsValidationContext.Provider value={onProviderSettingsValidationChange}>
        <OpenRouterModelMetadataContext.Provider value={value}>
          {children}
        </OpenRouterModelMetadataContext.Provider>
      </ProviderSettingsValidationContext.Provider>
    </AssistantDetailLevelProvider>
  );
}

export function useOpenRouterModelMetadataLookup(): OpenRouterModelMetadataLookup | undefined {
  return use(OpenRouterModelMetadataContext);
}

export function useProviderSettingsValidationChange():
  | ((reason: string | undefined) => void)
  | undefined {
  return use(ProviderSettingsValidationContext);
}
