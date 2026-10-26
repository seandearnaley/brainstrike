import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { createContext, type ReactElement, type ReactNode, useContext } from 'react';

export type AssistantProviderSource =
  | {
      /** Hosted Web has already resolved the complete provider set. */
      readonly kind: 'authoritative';
      readonly providers: readonly SupportedProvider[];
    }
  | {
      /** Desktop seeds are merged with the renderer's read of configured provider keys. */
      readonly kind: 'discovery';
      readonly seeds?: readonly SupportedProvider[];
    };

const AssistantProviderSourceContext = createContext<AssistantProviderSource | undefined>(
  undefined
);

export function AssistantProviderSourceProvider({
  children,
  source,
}: {
  readonly children: ReactNode;
  readonly source: AssistantProviderSource;
}): ReactElement {
  return <AssistantProviderSourceContext value={source}>{children}</AssistantProviderSourceContext>;
}

export function useAssistantProviderSource(): AssistantProviderSource {
  const source = useContext(AssistantProviderSourceContext);
  if (!source) {
    throw new Error('AssistantProviderSourceProvider is required');
  }
  return source;
}
