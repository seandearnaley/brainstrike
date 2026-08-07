import { createContext, type ReactNode, use } from 'react';
import type { ShellOutputAccumulation } from './shell-output-parts';

/**
 * Per-turn map of toolCallId → live streamed shell output. The chain provides it
 * (accumulated from the turn's transient `brainstrike.shell-output` data parts);
 * the deeply-nested ToolFallback cards read their own live output from it without
 * needing the AUI runtime (keeping the cards unit-testable). Empty by default —
 * so a reloaded thread (where these transient parts are absent) simply shows the
 * persisted final result instead.
 */
const ShellOutputContext = createContext<Record<string, ShellOutputAccumulation>>({});

export function ShellOutputProvider({
  children,
  outputs,
}: {
  children: ReactNode;
  outputs: Record<string, ShellOutputAccumulation>;
}) {
  return <ShellOutputContext.Provider value={outputs}>{children}</ShellOutputContext.Provider>;
}

export function useShellOutput(
  toolCallId: string | undefined
): ShellOutputAccumulation | undefined {
  const outputs = use(ShellOutputContext);
  return toolCallId === undefined ? undefined : outputs[toolCallId];
}
