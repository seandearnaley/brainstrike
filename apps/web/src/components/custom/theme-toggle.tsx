import { Button } from '@brainstrike/ui';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../providers/theme-provider';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      <Sun
        data-testid="theme-sun-icon"
        className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0"
      />
      <Moon
        data-testid="theme-moon-icon"
        className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
      />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
