'use client';

import { Label } from '@/components/ui/label';
import type React from 'react';

interface FolderSummaryThresholdSettingProps {
  value: number;
  onChange: (value: number) => void;
}

const FolderSummaryThresholdSetting: React.FC<FolderSummaryThresholdSettingProps> = ({
  value,
  onChange,
}) => (
  <div className="space-y-2">
    <Label htmlFor="folder-summary-threshold">Folder Summary Threshold</Label>
    <input
      type="number"
      id="folder-summary-threshold"
      min="0"
      value={value}
      onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
      className="w-full px-3 py-2 border rounded-md bg-background text-foreground"
    />
    <p className="text-sm text-muted-foreground">
      Number of files to show before summarizing folder contents (0 to show all)
    </p>
  </div>
);

export default FolderSummaryThresholdSetting;
