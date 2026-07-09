import { cn } from '@brainstrike/ui';
import { FileText, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';

const MODES = [
  { icon: <FileText className="h-3 w-3" />, label: 'Text', value: 'text' },
  { icon: <Sparkles className="h-3 w-3" />, label: 'Semantic', value: 'semantic' },
] as const;

/**
 * Segmented control for switching between text and semantic search. Matches the
 * app's canonical segmented pattern (the retrieval-mode control in
 * `search-config-panel`): active tab reads primary, inactive reads muted.
 * Store-driven — no props.
 */
export function SearchModeToggle(): ReactNode {
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const setMode = useWorkspaceSearchStore((state) => state.setMode);

  return (
    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA toolbar/toggle-group pattern for a button group, not a form fieldset.
    <div aria-label="Search mode" className="inline-flex items-center gap-1" role="group">
      {MODES.map(({ icon, label, value }) => {
        const isActive = mode === value;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
            key={value}
            onClick={() => setMode(value)}
            type="button"
          >
            {icon}
            {label}
          </button>
        );
      })}
    </div>
  );
}
