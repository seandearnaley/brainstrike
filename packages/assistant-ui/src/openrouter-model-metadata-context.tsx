import type { OpenRouterModelMetadataLookup } from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, use } from 'react';

const OpenRouterModelMetadataContext = createContext<OpenRouterModelMetadataLookup | undefined>(
  undefined
);
const ProviderSettingsValidationContext = createContext<
  ((reason: string | undefined) => void) | undefined
>(undefined);

export function MetadataProviders({
  children,
  onValidation,
  value,
}: {
  readonly children: ReactNode;
  readonly onValidation?: ((reason: string | undefined) => void) | undefined;
  readonly value: OpenRouterModelMetadataLookup | undefined;
}) {
  return (
    <ProviderSettingsValidationContext.Provider value={onValidation}>
      <OpenRouterModelMetadataContext.Provider value={value}>
        {children}
      </OpenRouterModelMetadataContext.Provider>
    </ProviderSettingsValidationContext.Provider>
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
