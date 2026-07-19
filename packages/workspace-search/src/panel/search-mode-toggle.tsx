import { cn, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { FileText, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { useSemanticAvailability } from './use-semantic-availability';

const BUTTON_BASE =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition-colors';

function modeButtonClass(isActive: boolean, gated: boolean): string {
  return cn(
    BUTTON_BASE,
    isActive
      ? 'bg-primary text-primary-foreground'
      : 'bg-muted text-muted-foreground hover:bg-muted/80',
    gated && 'cursor-not-allowed opacity-50 hover:bg-muted'
  );
}

/**
 * Segmented control for switching between text and semantic search. Matches the
 * app's canonical segmented pattern (the retrieval-mode control in
 * `search-config-panel`): active tab reads primary, inactive reads muted.
 * Store-driven — no props.
 *
 * The Semantic button is gated (with a named tooltip reason) when semantic
 * search cannot run for the selected set — see {@link useSemanticAvailability}.
 * We use `aria-disabled` rather than the native `disabled` attribute so the
 * button stays focusable/hoverable and its Radix tooltip can announce the
 * reason (a natively-disabled button drops out of the a11y tree and swallows
 * the pointer/focus events the tooltip needs — the gate must SHOW its reason,
 * never fail silently).
 *
 * The selected mode is user intent and is NEVER auto-rewritten from
 * availability: the toggle stays mounted while other tabs are active
 * (forceMount latch), and availability is a live async signal that transiently
 * reads unavailable during re-embed cycles (clearEmbeddings writes
 * embedded_chunk_count = 0 to collection_indexing_stats until the queue
 * re-embeds). An auto-revert here silently flipped semantic → text in the
 * background and nothing restored it — a silent fallback. Instead this gate
 * only blocks ENTERING semantic (button + tooltip); an already-selected gated
 * semantic mode is preserved, and its SUBMIT is blocked separately by the
 * panel's submit gate (`workspace-search-panel.tsx`), which surfaces the same
 * reason in the error card rather than letting the hybrid executor return
 * lexical-only results.
 */
export function SearchModeToggle(): ReactNode {
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const setMode = useWorkspaceSearchStore((state) => state.setMode);
  const collectionId = useWorkspaceSearchStore((state) => state.collectionId);
  const { available: semanticAvailable, reason: semanticReason } =
    useSemanticAvailability(collectionId);

  const semanticGated = !semanticAvailable;

  const semanticButton = (
    <button
      aria-disabled={semanticGated || undefined}
      aria-pressed={mode === 'semantic'}
      className={modeButtonClass(mode === 'semantic', semanticGated)}
      onClick={() => {
        if (semanticGated) {
          return;
        }
        setMode('semantic');
      }}
      type="button"
    >
      <Sparkles className="h-3 w-3" />
      Semantic
    </button>
  );

  return (
    <TooltipProvider>
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA toolbar/toggle-group pattern for a button group, not a form fieldset. */}
      <div aria-label="Search mode" className="inline-flex items-center gap-1" role="group">
        <button
          aria-pressed={mode === 'text'}
          className={modeButtonClass(mode === 'text', false)}
          onClick={() => setMode('text')}
          type="button"
        >
          <FileText className="h-3 w-3" />
          Text
        </button>

        {semanticGated ? (
          <Tooltip>
            <TooltipTrigger asChild>{semanticButton}</TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="max-w-[16rem] text-xs">{semanticReason}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          semanticButton
        )}
      </div>
    </TooltipProvider>
  );
}
