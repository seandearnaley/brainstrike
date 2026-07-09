import { Button } from '@brainstrike/ui';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';

/**
 * Two-button segmented control for switching between text and semantic
 * search. Store-driven — no props.
 */
export function SearchModeToggle() {
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const setMode = useWorkspaceSearchStore((state) => state.setMode);

  return (
    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA toolbar/toggle-group pattern for a button group, not a form fieldset.
    <div aria-label="Search mode" className="inline-flex items-center gap-1" role="group">
      <Button
        aria-pressed={mode === 'text'}
        onClick={() => setMode('text')}
        size="sm"
        type="button"
        variant={mode === 'text' ? 'secondary' : 'ghost'}
      >
        Text
      </Button>
      <Button
        aria-pressed={mode === 'semantic'}
        onClick={() => setMode('semantic')}
        size="sm"
        type="button"
        variant={mode === 'semantic' ? 'secondary' : 'ghost'}
      >
        Semantic
      </Button>
    </div>
  );
}
