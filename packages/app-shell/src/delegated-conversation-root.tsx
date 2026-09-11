import { createContext, type ReactNode, use, useMemo, useState } from 'react';
import {
  createDelegatedConversationRoot,
  type DelegatedConversationRoot,
} from './delegated-conversation-owner';

type Roots = Map<string, DelegatedConversationRoot>;
const RootsContext = createContext<Roots | null>(null);

/** Ephemeral roots live above child views and alongside the existing workspace tabs. */
export function DelegatedConversationRootsProvider({ children }: { readonly children: ReactNode }) {
  const [roots] = useState<Roots>(() => new Map());
  return <RootsContext value={roots}>{children}</RootsContext>;
}

export function useDelegatedConversationRoot(
  ownerResourceId: string,
  rootThreadId: string | undefined
): DelegatedConversationRoot | undefined {
  const roots = use(RootsContext);
  return useMemo(() => {
    if (!(roots && rootThreadId)) {
      return;
    }
    const key = JSON.stringify([ownerResourceId, rootThreadId]);
    let root = roots.get(key);
    if (!root) {
      root = createDelegatedConversationRoot(rootThreadId);
      roots.set(key, root);
    }
    return root;
  }, [roots, ownerResourceId, rootThreadId]);
}
