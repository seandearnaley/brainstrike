import type {
  AssistantCheckpointRevertResult,
  AssistantEditCheckpointRecord,
} from '@brainstrike/assistant-contract';
import { createContext, type ReactNode, useContext } from 'react';

/**
 * The four agent mutation tools whose tool cards can carry a Revert control. Kept
 * in the UI layer so `ToolFallback` can gate the button without importing the
 * desktop tool registry.
 */
export const REVERTIBLE_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'brainstrike.deleteWorkspaceFile',
  'brainstrike.renameWorkspaceFile',
  'brainstrike.stringReplaceWorkspaceFile',
  'brainstrike.writeWorkspaceFile',
]);

export interface EditCheckpointContextValue {
  /** Journal entries for the active thread, keyed by the tool call that made them. */
  readonly entriesByToolCallId: ReadonlyMap<string, AssistantEditCheckpointRecord>;
  /** Revert one edit. `force` skips the conflict check ("Revert anyway"). */
  readonly revertEntry: (
    id: string,
    options?: { force?: boolean }
  ) => Promise<AssistantCheckpointRevertResult>;
}

const EditCheckpointContext = createContext<EditCheckpointContextValue | null>(null);

export function EditCheckpointProvider({
  value,
  children,
}: {
  value: EditCheckpointContextValue | null;
  children: ReactNode;
}) {
  return <EditCheckpointContext.Provider value={value}>{children}</EditCheckpointContext.Provider>;
}

/**
 * The journal entry for a given tool call plus a bound revert action, or `null`
 * when there is no provider (web / not desktop) or no journal entry yet for this
 * call. A `null` return means "render no Revert control" — capability gating, not
 * a disabled stub.
 */
export function useCheckpointForToolCall(toolCallId: string): {
  entry: AssistantEditCheckpointRecord;
  revert: (options?: { force?: boolean }) => Promise<AssistantCheckpointRevertResult>;
} | null {
  const context = useContext(EditCheckpointContext);
  if (!context) {
    return null;
  }
  const entry = context.entriesByToolCallId.get(toolCallId);
  if (!entry) {
    return null;
  }
  return {
    entry,
    revert: (options) => context.revertEntry(entry.id, options),
  };
}
