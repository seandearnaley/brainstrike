import type { ReactNode } from 'react';
import {
  NativeWorkspaceSearchContext,
  type NativeWorkspaceSearchDependencies,
} from './native-workspace-search-context';

/** Installed native ownership stays explicit even while its capability is unavailable. */
export function NativeWorkspaceSearchProvider({
  dependencies,
  children,
}: {
  dependencies: NativeWorkspaceSearchDependencies;
  children: ReactNode;
}): ReactNode {
  return (
    <NativeWorkspaceSearchContext value={dependencies}>{children}</NativeWorkspaceSearchContext>
  );
}
