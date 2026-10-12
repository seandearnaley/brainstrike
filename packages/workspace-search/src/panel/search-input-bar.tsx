import {
  Button,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react';
import type { ReactNode } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';

export interface SearchInputBarProps {
  onSubmit: () => void;
}

interface ToggleIconButtonProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function ToggleIconButton({ active, icon, label, onClick }: ToggleIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={active}
          className="h-8 w-8 shrink-0"
          onClick={onClick}
          size="icon"
          type="button"
          variant={active ? 'secondary' : 'ghost'}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * `new RegExp(pattern)` parser message when `isRegex` is on and the pattern
 * is invalid, else null. Pure — validation has no side effects, so this
 * computes during render rather than via useState/useEffect.
 */
function regexValidationError(isRegex: boolean, query: string): string | null {
  if (!isRegex) {
    return null;
  }
  try {
    new RegExp(query);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Query input + Match Case / Match Whole Word / Use Regular Expression
 * toggles (VS Code order). Invalid regex patterns block submit and surface
 * the parser message; semantic mode surfaces a "press enter" hint since it
 * has no live-as-you-type debounce (Task 10 owns the debounce).
 */
export function SearchInputBar({ onSubmit }: SearchInputBarProps) {
  const query = useWorkspaceSearchStore((state) => state.query);
  const setQuery = useWorkspaceSearchStore((state) => state.setQuery);
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const caseSensitive = useWorkspaceSearchStore((state) => state.caseSensitive);
  const wholeWord = useWorkspaceSearchStore((state) => state.wholeWord);
  const isRegex = useWorkspaceSearchStore((state) => state.isRegex);
  const toggleCase = useWorkspaceSearchStore((state) => state.toggleCase);
  const toggleWholeWord = useWorkspaceSearchStore((state) => state.toggleWholeWord);
  const toggleRegex = useWorkspaceSearchStore((state) => state.toggleRegex);

  const regexError = regexValidationError(isRegex, query);
  const blocksSubmit = isRegex && regexError !== null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || blocksSubmit) {
      return;
    }
    onSubmit();
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1">
          <div className="relative min-w-32 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-invalid={blocksSubmit}
              className="h-8 w-full bg-background pl-9 text-sm"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search workspace"
              value={query}
            />
          </div>
          {/* Wraps below the query as one group when the panel is narrow. */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ToggleIconButton
              active={caseSensitive}
              icon={<CaseSensitive />}
              label="Match case"
              onClick={toggleCase}
            />
            <ToggleIconButton
              active={wholeWord}
              icon={<WholeWord />}
              label="Match whole word"
              onClick={toggleWholeWord}
            />
            <ToggleIconButton
              active={isRegex}
              icon={<Regex />}
              label="Use regular expression"
              onClick={toggleRegex}
            />
          </div>
        </div>
        {blocksSubmit ? (
          <div className="text-destructive text-xs" role="alert">
            {regexError}
          </div>
        ) : null}
        {mode === 'semantic' ? (
          <p className="text-muted-foreground text-xs">Press Enter to search</p>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
