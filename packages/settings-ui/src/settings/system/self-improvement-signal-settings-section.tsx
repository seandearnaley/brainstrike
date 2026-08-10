import { useSelfImprovementSignalPreferencesStore } from '@brainstrike/app-state/stores/self-improvement-signal-preferences-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Switch,
} from '@brainstrike/ui';

export function SelfImprovementSignalSettingsSection() {
  const enabled = useSelfImprovementSignalPreferencesStore((state) => state.enabled);
  const setEnabled = useSelfImprovementSignalPreferencesStore((state) => state.setEnabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Self-improvement signal</CardTitle>
        <CardDescription>
          Experimental: inject a summary of the assistant&apos;s own tool-usage waste (last 24h)
          into each run so it can adapt. Off by default.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <Label className="font-medium text-sm" htmlFor="self-improvement-signal-toggle">
            Inject self-improvement signal
          </Label>
          <Switch
            checked={enabled}
            data-testid="self-improvement-signal-toggle"
            id="self-improvement-signal-toggle"
            onCheckedChange={(value) => setEnabled(value === true)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
