import { useAuiState } from '@assistant-ui/react';
import { isSubagentDelegationToolName } from './subagent-tool-cards';
import {
  toolResultPreservesEffectsWhenHidden,
  useToolResultRenderers,
} from './use-tool-result-renderers';

/** A declared tool surface owner remains live when its pane is CSS-hidden. */
export function useThreadPresentationActivityMode(isVisible: boolean): 'hidden' | 'visible' {
  const renderers = useToolResultRenderers();
  const presentationVisible = useAuiState((state) => {
    if (isVisible) {
      return true;
    }
    if (renderers.length === 0) {
      return false;
    }
    return state.thread.messages.some((message) =>
      message.content.some(
        (part) =>
          part.type === 'tool-call' &&
          !isSubagentDelegationToolName(part.toolName) &&
          toolResultPreservesEffectsWhenHidden(renderers, part.result)
      )
    );
  });
  return presentationVisible ? 'visible' : 'hidden';
}
