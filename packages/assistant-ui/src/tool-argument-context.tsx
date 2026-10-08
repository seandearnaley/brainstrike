import { useAuiState } from '@assistant-ui/react';
import { createContext, type ReactNode, use, useState } from 'react';
import { collectToolArgumentsByCallId, type ToolArguments } from './tool-arguments';

type ToolArgumentsByCallId = ReadonlyMap<string, ToolArguments>;
type ThreadMessages = Parameters<typeof collectToolArgumentsByCallId>[0];

const EMPTY_TOOL_ARGUMENTS: ToolArgumentsByCallId = new Map<string, ToolArguments>();
const ToolArgumentContext = createContext<ToolArgumentsByCallId>(EMPTY_TOOL_ARGUMENTS);

function sameToolArguments(previous: ToolArgumentsByCallId, next: ToolArgumentsByCallId): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [toolCallId, entry] of next) {
    const before = previous.get(toolCallId);
    if (!before || before.args !== entry.args || before.argsText !== entry.argsText) {
      return false;
    }
  }
  return true;
}

/**
 * A memoized `useAuiState` selector (the vendor's documented "return a
 * memoized reference" form): it keeps returning the same map while no tool
 * call's arguments changed, so a text token, which replaces the thread's
 * message list, neither re-renders this provider nor any tool card reading it.
 */
function createToolArgumentsSelector(): (state: {
  readonly thread: { readonly messages: ThreadMessages };
}) => ToolArgumentsByCallId {
  let messages: ThreadMessages | undefined;
  let value = EMPTY_TOOL_ARGUMENTS;
  return (state) => {
    if (state.thread.messages === messages) {
      return value;
    }
    messages = state.thread.messages;
    const next = collectToolArgumentsByCallId(messages);
    if (!sameToolArguments(value, next)) {
      value = next;
    }
    return value;
  };
}

export function AssistantToolArgumentProvider({ children }: { readonly children: ReactNode }) {
  const [selectToolArguments] = useState(createToolArgumentsSelector);
  const value = useAuiState(selectToolArguments);
  return <ToolArgumentContext.Provider value={value}>{children}</ToolArgumentContext.Provider>;
}

export function useRememberedToolArguments(toolCallId: string): ToolArguments | undefined {
  return use(ToolArgumentContext).get(toolCallId);
}
