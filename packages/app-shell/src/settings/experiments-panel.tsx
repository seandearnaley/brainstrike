import { Button, Label, Switch } from '@brainstrike/ui';
import { useCallback, useMemo, useState } from 'react';
import { FEATURE_KEYS, isFileExplorerV2Enabled, setFileExplorerV2Enabled } from '../feature-flags';

export function ExperimentsPanel() {
  const initialEnabled = useMemo(() => isFileExplorerV2Enabled(), []);
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);

  const handleToggle = useCallback((checked: boolean) => {
    setEnabled(checked);
    setFileExplorerV2Enabled(checked);
    try {
      window.location.reload();
    } catch {}
  }, []);

  const handleReset = useCallback(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(FEATURE_KEYS.fileExplorerV2);
      }
    } catch {}
    try {
      window.location.reload();
    } catch {}
  }, []);

  return (
    <section aria-labelledby="experiments-title" className="space-y-3">
      <h2 id="experiments-title" className="text-xl font-semibold">
        Experiments
      </h2>

      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="flex items-center gap-3">
          <Switch
            id="ff-explorer-v2"
            checked={enabled}
            onCheckedChange={handleToggle}
            aria-label="Toggle File Explorer V2"
            data-testid="ff-explorer-v2-toggle"
          />
          <Label htmlFor="ff-explorer-v2" className="cursor-pointer">
            File Explorer V2
          </Label>
        </div>
        <span className="text-sm text-muted-foreground" data-testid="ff-explorer-v2-state">
          {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <p>
          URL override takes precedence over local settings: use <code>?ff_explorer_v2=1|true</code>
          .
        </p>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={handleReset}
          aria-label="Reset File Explorer V2 override"
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
