import { useAuiState } from '@assistant-ui/react';
import { createContext, type ReactNode, use, useMemo } from 'react';
import { collectToolArgumentsByCallId, type ToolArguments } from './tool-arguments';

const EMPTY_TOOL_ARGUMENTS = new Map<string, ToolArguments>();
const ToolArgumentContext = createContext<ReadonlyMap<string, ToolArguments>>(EMPTY_TOOL_ARGUMENTS);

export function AssistantToolArgumentProvider({ children }: { readonly children: ReactNode }) {
  const messages = useAuiState((state) => state.thread.messages);
  const value = useMemo(() => collectToolArgumentsByCallId(messages), [messages]);
  return <ToolArgumentContext.Provider value={value}>{children}</ToolArgumentContext.Provider>;
}

export function useRememberedToolArguments(toolCallId: string): ToolArguments | undefined {
  return use(ToolArgumentContext).get(toolCallId);
}
