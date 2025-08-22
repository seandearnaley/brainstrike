import { Label } from '@brainstrike/ui';
import type React from 'react';
import { useId } from 'react';

interface MaxSelectionCountSettingProps {
  value: number;
  onChange: (value: number) => void;
}

const MaxSelectionCountSetting: React.FC<MaxSelectionCountSettingProps> = ({ value, onChange }) => {
  const maxSelectionCountId = useId();

  return (
    <div className="space-y-2">
      <Label htmlFor={maxSelectionCountId}>Max Selection Count</Label>
      <input
        type="number"
        id={maxSelectionCountId}
        min="0"
        value={value}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="w-full px-3 py-2 border rounded-md bg-background text-foreground"
      />
      <p className="text-sm text-muted-foreground">
        Maximum number of files that can be selected at once
      </p>
    </div>
  );
};

export default MaxSelectionCountSetting;
