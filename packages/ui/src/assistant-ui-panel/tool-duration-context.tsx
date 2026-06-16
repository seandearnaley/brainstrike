import { createContext, type ReactNode, useContext } from 'react';

/**
 * Per-turn map of toolCallId → execution time (ms). The chain provides it
 * (computed from the turn's run events); the deeply-nested ToolFallback cards
 * read their own duration from it without needing access to the AUI runtime
 * (which keeps the cards unit-testable in isolation). Empty by default.
 */
const ToolDurationContext = createContext<Record<string, number>>({});

export function ToolDurationProvider({
  children,
  durations,
}: {
  children: ReactNode;
  durations: Record<string, number>;
}) {
  return <ToolDurationContext.Provider value={durations}>{children}</ToolDurationContext.Provider>;
}

export function useToolDurationMs(toolCallId: string | undefined): number | undefined {
  const durations = useContext(ToolDurationContext);
  return toolCallId === undefined ? undefined : durations[toolCallId];
}
