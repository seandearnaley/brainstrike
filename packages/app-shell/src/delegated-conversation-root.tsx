import { type ReactNode, useState } from 'react';
import { createDelegatedConversationRootRegistry } from './delegated-conversation-root-registry';
import { type Roots, RootsContext } from './use-delegated-conversation-root';

/** Ephemeral roots live above child views and alongside the existing workspace tabs. */
export function DelegatedConversationRootsProvider({ children }: { readonly children: ReactNode }) {
  const [roots] = useState<Roots>(createDelegatedConversationRootRegistry);
  return <RootsContext value={roots}>{children}</RootsContext>;
}
