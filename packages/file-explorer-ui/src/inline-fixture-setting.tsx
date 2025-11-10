import { FileExplorerStrings } from '@brainstrike/types';
import { Label, Switch } from '@brainstrike/ui';
import type React from 'react';

interface InlineFixtureSettingProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const InlineFixtureSetting: React.FC<InlineFixtureSettingProps> = ({
  checked,
  disabled = false,
  onChange,
}) => (
  <div className="rounded-md border p-3 flex flex-col gap-2 bg-card/60">
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <Label htmlFor="inline-fixture-toggle">
          {FileExplorerStrings.inlineFixture.settingLabel}
        </Label>
        <p className="text-xs text-muted-foreground">
          {FileExplorerStrings.inlineFixture.settingDescription}
        </p>
      </div>
      <Switch
        id="inline-fixture-toggle"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={FileExplorerStrings.inlineFixture.settingLabel}
      />
    </div>
  </div>
);

export default InlineFixtureSetting;
