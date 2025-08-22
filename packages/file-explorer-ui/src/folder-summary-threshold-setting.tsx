import { Label } from '@brainstrike/ui';
import type React from 'react';
import { useId } from 'react';

interface FolderSummaryThresholdSettingProps {
  value: number;
  onChange: (value: number) => void;
}

const FolderSummaryThresholdSetting: React.FC<FolderSummaryThresholdSettingProps> = ({
  value,
  onChange,
}) => {
  const thresholdId = useId();

  return (
    <div className="space-y-2">
      <Label htmlFor={thresholdId}>Folder Summary Threshold</Label>
      <input
        type="number"
        id={thresholdId}
        min="0"
        value={value}
        onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
        className="w-full px-3 py-2 border rounded-md bg-background text-foreground"
      />
      <p className="text-sm text-muted-foreground">
        Number of files shown in each folder of the <strong>report&apos;s project tree</strong>{' '}
        before the rest are summarized. Set to 0 to show all.
      </p>
    </div>
  );
};

export default FolderSummaryThresholdSetting;
