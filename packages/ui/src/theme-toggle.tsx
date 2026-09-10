// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Moon, Sun } from 'lucide-react';
import { Button } from './button';
import { useTheme } from './theme-provider';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const nextMode = mode === 'light' ? 'dark' : 'light';
  const tooltipLabel = `Switch to ${nextMode} mode`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={tooltipLabel}
          className="h-12 w-12 rounded-lg transition-colors duration-200 ease-out hover:shadow-sm"
          depress={false}
          onClick={() => setMode(nextMode)}
          size="icon"
          variant="ghost"
        >
          <Sun
            aria-hidden="true"
            className="h-5 w-5 rotate-0 scale-100 transition-all duration-300 dark:-rotate-90 dark:scale-0"
            data-testid="theme-sun-icon"
          />
          <Moon
            aria-hidden="true"
            className="absolute h-5 w-5 rotate-90 scale-0 transition-all duration-300 dark:rotate-0 dark:scale-100"
            data-testid="theme-moon-icon"
          />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <p className="font-medium">{tooltipLabel}</p>
      </TooltipContent>
    </Tooltip>
  );
}
