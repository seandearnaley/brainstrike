import { Button } from '@brainstrike/ui';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Button
      onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      size="icon"
      title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      variant="ghost"
    >
      <Sun
        className="dark:-rotate-90 h-5 w-5 rotate-0 scale-100 transition-all dark:scale-0"
        data-testid="theme-sun-icon"
      />
      <Moon
        className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100"
        data-testid="theme-moon-icon"
      />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
