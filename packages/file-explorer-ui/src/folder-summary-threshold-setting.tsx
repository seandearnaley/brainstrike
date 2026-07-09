import { Label } from '@brainstrike/ui';

interface FolderSummaryThresholdSettingProps {
  onChange: (value: number) => void;
  value: number;
}

const FolderSummaryThresholdSetting = ({ value, onChange }: FolderSummaryThresholdSettingProps) => (
  <div className="space-y-2">
    <Label htmlFor="folder-summary-threshold">Folder Summary Threshold</Label>
    <input
      className="w-full rounded-md border bg-background px-3 py-2 text-foreground"
      id="folder-summary-threshold"
      min="0"
      onChange={(e) => onChange(Number.parseInt(e.target.value, 10))}
      type="number"
      value={value}
    />
    <p className="text-muted-foreground text-sm">
      Number of files shown in each folder of the <strong>report&apos;s project tree</strong> before
      the rest are summarized. Set to 0 to show all.
    </p>
  </div>
);

export default FolderSummaryThresholdSetting;
