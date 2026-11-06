import { Label, Switch } from '@brainstrike/ui';

export interface InlineFixtureSettingsPanelProps {
  checked: boolean;
  isAvailable: boolean;
  isLoading: boolean;
  onChange: (checked: boolean) => void;
}

export function InlineFixtureSettingsPanel({
  checked,
  isAvailable,
  isLoading,
  onChange,
}: InlineFixtureSettingsPanelProps): React.ReactNode {
  if (!isAvailable) {
    return null;
  }

  return (
    <div className="border-warning/40 bg-warning/10 space-y-1 rounded-md border p-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label className="text-xs" htmlFor="inline-fixture-settings-toggle">
            Developer: inline fixtures
          </Label>
          <p className="text-muted-foreground text-2xs">
            Load a built-in test fixture into the file explorer without selecting a real folder.
          </p>
        </div>
        <Switch
          aria-label="Enable inline fixtures"
          checked={checked}
          disabled={isLoading}
          id="inline-fixture-settings-toggle"
          onCheckedChange={onChange}
        />
      </div>
    </div>
  );
}
