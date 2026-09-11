import { type ReactNode, useState } from 'react';
import { type Roots, RootsContext } from './use-delegated-conversation-root';

/** Ephemeral roots live above child views and alongside the existing workspace tabs. */
export function DelegatedConversationRootsProvider({ children }: { readonly children: ReactNode }) {
  const [roots] = useState<Roots>(() => new Map());
  return <RootsContext value={roots}>{children}</RootsContext>;
}
