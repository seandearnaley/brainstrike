/**
 * Provider half of the Explorer columns context.
 *
 * Component-only by contract — see the boundary note in
 * `explorer-columns-context.ts`.
 */
import type { ReactNode } from 'react';
import {
  ExplorerColumnsContext,
  type ExplorerColumnsContextValue,
} from './explorer-columns-context';

export function ExplorerColumnsProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ExplorerColumnsContextValue;
}) {
  return (
    <ExplorerColumnsContext.Provider value={value}>{children}</ExplorerColumnsContext.Provider>
  );
}
