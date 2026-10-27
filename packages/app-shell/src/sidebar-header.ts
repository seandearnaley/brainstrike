import { createContext, useContext } from 'react';

/**
 * The left panel's header row. The sidebar renders its own toolbar there (a
 * portal), so it spends no row of its own on chrome. `null` until the row
 * mounts; `undefined` means no workspace layout provides one.
 */
export const SidebarHeaderContext = createContext<HTMLElement | null | undefined>(undefined);

export function useSidebarHeader(): HTMLElement | null {
  const header = useContext(SidebarHeaderContext);
  if (header === undefined) {
    throw new Error('The sidebar must render inside AgentWorkspaceLayout, which owns its header.');
  }
  return header;
}
