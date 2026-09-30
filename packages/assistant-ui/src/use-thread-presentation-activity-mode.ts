import { useAuiState } from '@assistant-ui/react';
import {
  toolResultPartPreservesEffectsWhenHidden,
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
      message.content.some((part) => toolResultPartPreservesEffectsWhenHidden(renderers, part))
    );
  });
  return presentationVisible ? 'visible' : 'hidden';
}
