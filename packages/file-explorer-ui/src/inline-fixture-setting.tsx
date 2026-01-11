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
  <div className="flex flex-col gap-2 rounded-md border bg-card/60 p-3">
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <Label htmlFor="inline-fixture-toggle">
          {FileExplorerStrings.inlineFixture.settingLabel}
        </Label>
        <p className="text-muted-foreground text-xs">
          {FileExplorerStrings.inlineFixture.settingDescription}
        </p>
      </div>
      <Switch
        aria-label={FileExplorerStrings.inlineFixture.settingLabel}
        checked={checked}
        disabled={disabled}
        id="inline-fixture-toggle"
        onCheckedChange={onChange}
      />
    </div>
  </div>
);

export default InlineFixtureSetting;
