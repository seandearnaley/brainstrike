import { Button, Label } from '@brainstrike/ui';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './theme-provider';

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <Label>Theme</Label>
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
