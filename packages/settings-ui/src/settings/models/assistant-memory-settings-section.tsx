import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import {
  ASSISTANT_MEMORY_NUMBER_LIMITS,
  useAssistantMemoryPreferencesStore,
} from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
} from '@brainstrike/assistant-contract/memory-settings';
import { OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET } from '@brainstrike/assistant-contract/memory-settings';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { Card, Label, ModelSelect, Switch } from '@brainstrike/ui';
import { BrainCircuit } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { MemoryNumberField } from './assistant-memory-fields';
import {
  type AssistantMemoryModelOption,
  formatMemoryScopeLabel,
  listObservationalMemoryModelOptions,
} from './assistant-memory-models';

const SCOPES: readonly RuntimeAssistantMemoryScope[] = ['thread', 'resource'];
const RETRIEVAL_MODES: readonly RuntimeAssistantMemoryRetrievalMode[] = ['off', 'messages'];

function retrievalModeLabel(mode: RuntimeAssistantMemoryRetrievalMode): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'messages':
      return 'Raw message recall';
    default: {
      const exhaustiveMode: never = mode;
      return exhaustiveMode;
    }
  }
}

export interface AssistantMemorySettingsSectionProps {
  readonly assistantMemoryBackendAvailable: boolean;
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
}

interface ObservationalMemoryModelFieldProps {
  readonly hasUnavailableObservationModel: boolean;
  readonly modelTarget: string;
  readonly observationalMemoryEnabled: boolean;
  readonly observationOptions: readonly AssistantMemoryModelOption[];
  readonly onModelTargetChange: (target: string) => void;
}

function ObservationalMemoryModelField({
  hasUnavailableObservationModel,
  observationOptions,
  observationalMemoryEnabled,
  modelTarget,
  onModelTargetChange,
}: ObservationalMemoryModelFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="assistant-memory-observation-model">Observational memory model</Label>
      <ModelSelect
        // The height of the section's other fields.
        className="h-10"
        id="assistant-memory-observation-model"
        onValueChange={onModelTargetChange}
        options={[
          // Auto never sends the conversation to a provider the chat doesn't already use.
          { label: 'Auto (chat’s provider)', value: OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET },
          ...observationOptions.map((option) => ({
            label: option.label,
            markLabel: option.markLabel,
            provider: option.providerId,
            value: option.target,
            vendor: option.vendor,
          })),
        ]}
        value={modelTarget}
      />
      {hasUnavailableObservationModel && (
        <p
          className={
            observationalMemoryEnabled
              ? 'text-destructive text-xs'
              : 'text-muted-foreground text-xs'
          }
          role={observationalMemoryEnabled ? 'alert' : 'status'}
        >
          Configured observational memory model {modelTarget} is not available with the current
          provider credentials. Configure its API key in Settings → Providers, choose an observer
          whose provider has a key, or turn observations off.
        </p>
      )}
    </div>
  );
}

export function AssistantMemorySettingsSection({
  assistantMemoryBackendAvailable,
  providerKeySources,
}: AssistantMemorySettingsSectionProps) {
  useEnsureModelRegistry();

  const { hasLoaded, models, providers } = useModelRegistryStore(
    useShallow((state) => ({
      hasLoaded: state.hasLoaded,
      models: state.models,
      providers: state.providers,
    }))
  );
  const {
    observationalMemory,
    setObservationMessageTokens,
    setObservationalMemoryEnabled,
    setObservationalMemoryModelTarget,
    setObservationalMemoryScope,
    setObservationalRetrievalMode,
    setReflectionObservationTokens,
  } = useAssistantMemoryPreferencesStore(
    useShallow((state) => ({
      observationalMemory: state.observationalMemory,
      setObservationalMemoryEnabled: state.setObservationalMemoryEnabled,
      setObservationalMemoryModelTarget: state.setObservationalMemoryModelTarget,
      setObservationalMemoryScope: state.setObservationalMemoryScope,
      setObservationalRetrievalMode: state.setObservationalRetrievalMode,
      setObservationMessageTokens: state.setObservationMessageTokens,
      setReflectionObservationTokens: state.setReflectionObservationTokens,
    }))
  );

  const observationOptions = listObservationalMemoryModelOptions({
    assistantMemoryBackendAvailable,
    models,
    ...(providerKeySources ? { providerKeySources } : {}),
    providers,
  });
  const isAutoObservationTarget =
    observationalMemory.modelTarget === OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET;
  const hasObservationModel =
    isAutoObservationTarget ||
    observationOptions.some((option) => option.target === observationalMemory.modelTarget);
  const hasUnavailableObservationModel =
    providerKeySources !== undefined && hasLoaded && !hasObservationModel;
  const canToggleObservations = hasObservationModel || observationalMemory.enabled;

  return (
    <Card className="space-y-5 p-4" data-testid="assistant-memory-settings-section">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <BrainCircuit className="text-muted-foreground h-4 w-4" />
          <h3 className="text-sm font-medium">Observational memory</h3>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="assistant-memory-observational-enabled">Enable observations</Label>
          <Switch
            aria-label="Enable observational memory"
            checked={observationalMemory.enabled}
            disabled={!canToggleObservations}
            id="assistant-memory-observational-enabled"
            onCheckedChange={setObservationalMemoryEnabled}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ObservationalMemoryModelField
          hasUnavailableObservationModel={hasUnavailableObservationModel}
          modelTarget={observationalMemory.modelTarget}
          observationalMemoryEnabled={observationalMemory.enabled}
          observationOptions={observationOptions}
          onModelTargetChange={setObservationalMemoryModelTarget}
        />

        <div className="space-y-2">
          <Label htmlFor="assistant-memory-observation-scope">Observation scope</Label>
          <select
            aria-label="Observation scope"
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            id="assistant-memory-observation-scope"
            onChange={(event) =>
              setObservationalMemoryScope(event.target.value as RuntimeAssistantMemoryScope)
            }
            value={observationalMemory.scope}
          >
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {formatMemoryScopeLabel(scope)}
              </option>
            ))}
          </select>
        </div>

        <MemoryNumberField
          id="assistant-memory-message-tokens"
          label="Observe messages after"
          {...ASSISTANT_MEMORY_NUMBER_LIMITS.tokenThreshold}
          onValidChange={setObservationMessageTokens}
          step={1000}
          value={observationalMemory.messageTokens}
        />

        <MemoryNumberField
          id="assistant-memory-observation-tokens"
          label="Reflect observations after"
          {...ASSISTANT_MEMORY_NUMBER_LIMITS.tokenThreshold}
          onValidChange={setReflectionObservationTokens}
          step={1000}
          value={observationalMemory.observationTokens}
        />

        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="assistant-memory-retrieval-mode">Observation retrieval mode</Label>
          <select
            aria-label="Observation retrieval mode"
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            id="assistant-memory-retrieval-mode"
            onChange={(event) =>
              setObservationalRetrievalMode(
                event.target.value as RuntimeAssistantMemoryRetrievalMode
              )
            }
            value={observationalMemory.retrievalMode}
          >
            {RETRIEVAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {retrievalModeLabel(mode)}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}
