import { useExperimentAssignmentPreferencesStore } from '@brainstrike/app-state/stores/experiment-assignment-preferences-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@brainstrike/ui';

/**
 * Experiment enrollment (BST-1251). Attribution metadata only: the pair is
 * recorded verbatim on every run's treatment row (BST-1250) and changes no
 * runtime behavior. Blank fields = un-enrolled; the request only rides the
 * wire when BOTH fields are set.
 */
export function ExperimentAssignmentSettingsSection() {
  const experimentId = useExperimentAssignmentPreferencesStore((state) => state.experimentId);
  const variant = useExperimentAssignmentPreferencesStore((state) => state.variant);
  const setExperimentId = useExperimentAssignmentPreferencesStore((state) => state.setExperimentId);
  const setVariant = useExperimentAssignmentPreferencesStore((state) => state.setVariant);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Experiment enrollment</CardTitle>
        <CardDescription>
          Experimental: tag every assistant run with an experiment id and variant so treatments can
          be attributed afterward. Leave blank to stay un-enrolled. Enrollment only labels runs; it
          does not change behavior by itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label className="font-medium text-sm" htmlFor="experiment-assignment-experiment-id">
            Experiment id
          </Label>
          <Input
            className="max-w-64"
            data-testid="experiment-assignment-experiment-id"
            defaultValue={experimentId ?? ''}
            id="experiment-assignment-experiment-id"
            onChange={(event) => setExperimentId(event.target.value)}
            placeholder="e.g. search-policy-v1"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="font-medium text-sm" htmlFor="experiment-assignment-variant">
            Variant
          </Label>
          <Input
            className="max-w-64"
            data-testid="experiment-assignment-variant"
            defaultValue={variant ?? ''}
            id="experiment-assignment-variant"
            onChange={(event) => setVariant(event.target.value)}
            placeholder="e.g. control"
          />
        </div>
      </CardContent>
    </Card>
  );
}
