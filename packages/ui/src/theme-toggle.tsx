import { Button } from '@brainstrike/ui';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const tooltipLabel = `Switch to ${nextTheme} mode`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={tooltipLabel}
          className="kinetic-depress h-12 w-12 rounded-lg transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-sm active:translate-y-0"
          onClick={() => setTheme(nextTheme)}
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
