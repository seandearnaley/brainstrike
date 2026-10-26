import {
  useAvailableModels,
  useAvailableProviders,
} from '@brainstrike/app-state/hooks/use-available-embedding-models';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type { IndexModel } from '@brainstrike/assistant-contract/index-config';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ModelPicker,
} from '@brainstrike/ui';
import { useState } from 'react';

export function SearchIndexModelCard({
  disabled,
  model,
  onChange,
}: {
  readonly disabled: boolean;
  readonly model: IndexModel | null;
  readonly onChange: (model: IndexModel) => void;
}) {
  const registryError = useEnsureModelRegistry();
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const availableModels = useAvailableModels(models);
  const availableProviders = useAvailableProviders(providers);
  const [unverified, setUnverified] = useState<string | null>(null);
  const choose = (modelKey: string): void => {
    setUnverified(null);
    if (modelKey === model?.modelKey) {
      return;
    }
    const choice = availableModels.find((candidate) => candidate.id === modelKey);
    const dimensions = choice?.capabilities.defaultDimension;
    if (
      !choice ||
      typeof dimensions !== 'number' ||
      !Number.isInteger(dimensions) ||
      dimensions <= 0
    ) {
      setUnverified(choice?.name ?? modelKey);
      return;
    }
    onChange({ dimensions, modelKey: choice.id });
  };
  const selectedName =
    availableModels.find((candidate) => candidate.id === model?.modelKey)?.name ?? model?.modelKey;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedding model</CardTitle>
        <CardDescription>Changing it re-embeds every chunk.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ModelPicker
          disabled={disabled}
          mode="single"
          models={availableModels}
          modelType="embedding"
          onChange={(value) => {
            if (typeof value === 'string') {
              choose(value);
            }
          }}
          providers={availableProviders}
          renderTrigger={() => (
            <Button
              aria-label="Embedding model"
              disabled={disabled}
              role="combobox"
              type="button"
              variant="outline"
            >
              {selectedName ?? 'Choose an embedding model'}
            </Button>
          )}
          value={model?.modelKey ?? ''}
        />
        {unverified ? (
          <p className="text-destructive text-sm" role="alert">
            {unverified} has no verified embedding dimensions.
          </p>
        ) : null}
        {registryError ? (
          <p className="text-destructive text-sm" role="alert">
            {registryError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
