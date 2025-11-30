import { Label } from '@brainstrike/ui';
import type React from 'react';

type MaxSelectionCountSettingProps = {
  value: number;
  onChange: (value: number) => void;
};

const MaxSelectionCountSetting: React.FC<MaxSelectionCountSettingProps> = ({ value, onChange }) => (
  <div className="space-y-2">
    <Label htmlFor="max-selection-count">Max Selection Count</Label>
    <input
      className="w-full rounded-md border bg-background px-3 py-2 text-foreground"
      id="max-selection-count"
      min="0"
      onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
      type="number"
      value={value}
    />
    <p className="text-muted-foreground text-sm">
      Maximum number of files that can be selected at once
    </p>
  </div>
);

export default MaxSelectionCountSetting;
