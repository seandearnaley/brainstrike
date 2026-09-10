// Sibling components below use relative paths, never this package's own
// `@brainstrike/ui` barrel — that would close a source cycle. See the fuller
// note in error-boundary.tsx (BST-890).

import { Monitor, Moon, Sun } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from './button';
import { Label } from './label';
import { cn } from './lib/utils';
import { type ThemeMode, useTheme } from './theme-provider';
import { THEMES, type ThemeDefinition } from './themes';

const MODE_OPTIONS: ReadonlyArray<{
  icon: ComponentType<{ className?: string; 'data-testid'?: string }>;
  label: string;
  mode: ThemeMode;
  testId: string;
}> = [
  { icon: Sun, label: 'Light', mode: 'light', testId: 'light-theme-icon' },
  { icon: Moon, label: 'Dark', mode: 'dark', testId: 'dark-theme-icon' },
  { icon: Monitor, label: 'System', mode: 'system', testId: 'system-theme-icon' },
];

function Swatch({ color, testId }: { color: string; testId: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 rounded-sm border border-border"
      data-testid={testId}
      style={{ backgroundColor: color }}
    />
  );
}

function ThemeCard({
  active,
  onSelect,
  theme,
}: {
  active: boolean;
  onSelect: () => void;
  theme: ThemeDefinition;
}) {
  return (
    /* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio pattern for a rich swatch+label card; <input type="radio"> cannot host this content. */
    <button
      aria-checked={active}
      aria-label={theme.label}
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
        active
          ? 'border-primary ring-2 ring-ring/50'
          : 'border-border hover:bg-accent hover:text-accent-foreground'
      )}
      data-testid={`theme-card-${theme.id}`}
      onClick={onSelect}
      role="radio"
      type="button"
    >
      <span className="flex gap-1">
        <Swatch
          color={theme.swatch.light.background}
          testId={`theme-swatch-${theme.id}-light-background`}
        />
        <Swatch
          color={theme.swatch.light.primary}
          testId={`theme-swatch-${theme.id}-light-primary`}
        />
        <Swatch
          color={theme.swatch.dark.background}
          testId={`theme-swatch-${theme.id}-dark-background`}
        />
        <Swatch
          color={theme.swatch.dark.primary}
          testId={`theme-swatch-${theme.id}-dark-primary`}
        />
      </span>
      <span className="font-medium text-sm">{theme.label}</span>
    </button>
  );
}

export function ThemeSettings() {
  const { mode, setMode, setTheme, theme } = useTheme();

  return (
    <div className="grid gap-6">
      <div className="space-y-2">
        <Label>Mode</Label>
        <div className="grid grid-cols-3 gap-4">
          {MODE_OPTIONS.map(({ icon: Icon, label, mode: option, testId }) => (
            <Button
              aria-pressed={mode === option}
              className="w-full"
              key={option}
              onClick={() => setMode(option)}
              variant={mode === option ? 'default' : 'outline'}
            >
              <Icon className="mr-2 h-5 w-5" data-testid={testId} />
              {label}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-sm">
          Light, dark, or follow your device setting. Every theme below has both a light and a dark
          look.
        </p>
      </div>
      <div className="space-y-2">
        <Label id="theme-palette-label">Theme</Label>
        <div
          aria-labelledby="theme-palette-label"
          className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          role="radiogroup"
        >
          {THEMES.map((definition) => (
            <ThemeCard
              active={theme === definition.id}
              key={definition.id}
              onSelect={() => setTheme(definition.id)}
              theme={definition}
            />
          ))}
        </div>
        <p className="text-muted-foreground text-sm">
          Pick a colour palette. Fonts and icons stay the same.
        </p>
      </div>
    </div>
  );
}
