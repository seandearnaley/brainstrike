import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { useTheme } from '../../../providers/theme-provider';
import { Label } from '../../ui/label';

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <Label>Theme</Label>
        <div className="grid grid-cols-3 gap-4">
          <Button
            variant={theme === 'light' ? 'default' : 'outline'}
            className="w-full"
            onClick={() => setTheme('light')}
          >
            <Sun className="h-5 w-5 mr-2" data-testid="light-theme-icon" />
            Light
          </Button>
          <Button
            variant={theme === 'dark' ? 'default' : 'outline'}
            className="w-full"
            onClick={() => setTheme('dark')}
          >
            <Moon className="h-5 w-5 mr-2" data-testid="dark-theme-icon" />
            Dark
          </Button>
          <Button
            variant={theme === 'system' ? 'default' : 'outline'}
            className="w-full"
            onClick={() => setTheme('system')}
          >
            <Monitor className="h-5 w-5 mr-2" data-testid="system-theme-icon" />
            System
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Select your preferred theme mode. System will automatically match your device settings.
        </p>
      </div>
    </div>
  );
}
