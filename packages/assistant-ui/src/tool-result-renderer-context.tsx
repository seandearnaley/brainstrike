import type { ReactElement, ReactNode } from 'react';
import { type ToolResultRenderer, ToolResultRendererContext } from './use-tool-result-renderers';

export interface ToolResultRendererProviderProps {
  readonly children: ReactNode;
  readonly renderers: readonly ToolResultRenderer[];
}

/** Mount once per host with the renderers that host can actually drive. */
export function ToolResultRendererProvider({
  children,
  renderers,
}: ToolResultRendererProviderProps): ReactElement {
  return (
    <ToolResultRendererContext.Provider value={renderers}>
      {children}
    </ToolResultRendererContext.Provider>
  );
}
