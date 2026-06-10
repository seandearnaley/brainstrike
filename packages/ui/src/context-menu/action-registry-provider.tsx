import type { ActionRegistry } from '@brainstrike/context-actions';
import { createContext, type ReactNode, useContext } from 'react';

const ActionRegistryContext = createContext<ActionRegistry | null>(null);

export function ActionRegistryProvider({
  registry,
  children,
}: {
  registry: ActionRegistry;
  children: ReactNode;
}) {
  return (
    <ActionRegistryContext.Provider value={registry}>{children}</ActionRegistryContext.Provider>
  );
}

/**
 * Strict accessor: a surface that renders an ActionContextMenu without a
 * mounted registry is a wiring bug, surfaced immediately (no silent no-op
 * menus). Tests wrap with createTestActionRegistry().
 */
export function useActionRegistry(): ActionRegistry {
  const registry = useContext(ActionRegistryContext);
  if (!registry) {
    throw new Error('useActionRegistry must be used inside an <ActionRegistryProvider>.');
  }
  return registry;
}
