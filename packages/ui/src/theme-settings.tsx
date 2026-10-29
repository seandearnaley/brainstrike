// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from './button';
import { useTheme } from './theme-provider';

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <p className="text-sm leading-none font-medium">Theme</p>
        <div className="grid grid-cols-3 gap-4">
          <Button
            className="w-full"
            onClick={() => setTheme('light')}
            variant={theme === 'light' ? 'default' : 'outline'}
          >
            <Sun className="mr-2 h-5 w-5" data-testid="light-theme-icon" />
            Light
          </Button>
          <Button
            className="w-full"
            onClick={() => setTheme('dark')}
            variant={theme === 'dark' ? 'default' : 'outline'}
          >
            <Moon className="mr-2 h-5 w-5" data-testid="dark-theme-icon" />
            Dark
          </Button>
          <Button
            className="w-full"
            onClick={() => setTheme('system')}
            variant={theme === 'system' ? 'default' : 'outline'}
          >
            <Monitor className="mr-2 h-5 w-5" data-testid="system-theme-icon" />
            System
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Select your preferred theme mode. System will automatically match your device settings.
        </p>
      </div>
    </div>
  );
}
