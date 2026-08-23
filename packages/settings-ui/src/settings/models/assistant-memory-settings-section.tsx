import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
} from '@brainstrike/assistant-contract/memory-settings';
import { OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET } from '@brainstrike/assistant-contract/memory-settings';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { Badge, Card, Input, Label, Switch } from '@brainstrike/ui';
import { BrainCircuit } from 'lucide-react';
import {
  formatMemoryScopeLabel,
  listObservationalMemoryModelOptions,
  listSemanticRecallEmbeddingModelOptions,
} from './assistant-memory-models';

const SCOPES: readonly RuntimeAssistantMemoryScope[] = ['thread', 'resource'];
const RETRIEVAL_MODES: readonly RuntimeAssistantMemoryRetrievalMode[] = [
  'off',
  'messages',
  'vector',
];

function retrievalModeLabel(mode: RuntimeAssistantMemoryRetrievalMode): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'messages':
      return 'Raw message recall';
    case 'vector':
      return 'Semantic observation recall';
    default: {
      const exhaustiveMode: never = mode;
      return exhaustiveMode;
    }
  }
}

function parseNumberInput(value: string): number {
  if (value.trim().length === 0) {
    return Number.NaN;
  }
  return Number(value);
}

/**
 * The providers a MANUAL observer target would straddle, or null when it would
 * not straddle any.
 *
 * Auto is excluded by construction: it only ever resolves an observer from the
 * selected chat provider — the party already receiving the conversation — and
 * the copy beside it says so. A manual target carries no such constraint, and
 * nothing previously told the user when it crossed.
 *
 * Null with no chat model selected: there is nothing to compare against, and a
 * warning on first run would be noise.
 */
function resolveCrossProviderObserverEgress(input: {
  chatModelKey: string | null;
  isAutoObservationTarget: boolean;
  observerTarget: string;
}): { chatProvider: string; observerProvider: string } | null {
  if (input.isAutoObservationTarget || !input.chatModelKey) {
    return null;
  }
  const chatProvider = input.chatModelKey.split('::')[0];
  const observerProvider = input.observerTarget.split('/')[0];
  if (!(chatProvider && observerProvider) || chatProvider === observerProvider) {
    return null;
  }
  return { chatProvider, observerProvider };
}

export interface AssistantMemorySettingsSectionProps {
  readonly assistantMemoryBackendAvailable: boolean;
  readonly providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
}

interface ObservationalMemoryModelFieldProps {
  /** Chat provider the observer would cross, or null when it would not. */
  readonly crossProviderEgress: { chatProvider: string; observerProvider: string } | null;
  readonly hasObservationModel: boolean;
  readonly hasUnavailableObservationModel: boolean;
  readonly isAutoObservationTarget: boolean;
  readonly modelTarget: string;
  readonly observationalMemoryEnabled: boolean;
  readonly observationOptions: readonly { label: string; target: string }[];
  readonly onModelTargetChange: (target: string) => void;
}

function ObservationalMemoryModelField({
  crossProviderEgress,
  hasObservationModel,
  hasUnavailableObservationModel,
  isAutoObservationTarget,
  observationOptions,
  observationalMemoryEnabled,
  modelTarget,
  onModelTargetChange,
}: ObservationalMemoryModelFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="assistant-memory-observation-model">Observational memory model</Label>
      <select
        aria-label="Observational memory model"
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        id="assistant-memory-observation-model"
        onChange={(event) => onModelTargetChange(event.target.value)}
        value={hasObservationModel ? modelTarget : ''}
      >
        {!hasObservationModel && <option value="">Select an enabled hosted LLM model</option>}
        <option value={OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET}>
          Auto — fastest eligible observer (recommended)
        </option>
        {observationOptions.map((option) => (
          <option key={option.target} value={option.target}>
            {option.label}
          </option>
        ))}
      </select>
      {isAutoObservationTarget ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="assistant-memory-auto-observer-note"
        >
          Auto observes with a fast, Mastra-recommended model from your active chat provider only
          (e.g. Haiku for Anthropic chats) — the conversation never reaches a provider that is not
          already receiving it. Local chats keep observations paused.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          The target identifies a provider/model such as{' '}
          <span className="font-mono">openai/gpt-5.4-mini</span>; Desktop resolves its credential
          before constructing the observer.
        </p>
      )}
      {crossProviderEgress && (
        <p
          className="text-warning text-xs"
          data-testid="assistant-memory-cross-provider-observer"
          role="status"
        >
          This observer runs on {crossProviderEgress.observerProvider}, but you are chatting with{' '}
          {crossProviderEgress.chatProvider}. Your conversation is sent to{' '}
          {crossProviderEgress.observerProvider} as well, which Auto never does. Pick an Auto or{' '}
          {crossProviderEgress.chatProvider} observer to keep it with one provider.
        </p>
      )}
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
          provider credentials. Configure its API key in Settings → Providers, choose a keyless
          local observer, or turn observations off.
        </p>
      )}
    </div>
  );
}

export function AssistantMemorySettingsSection({
  assistantMemoryBackendAvailable,
  providerKeySources,
}: AssistantMemorySettingsSectionProps) {
  const db = usePGliteDatabase();
  useEnsureModelRegistry({ db });

  const { hasLoaded, models, providers } = useModelRegistryStore();
  const selectedModel = useAssistantPreferencesStore((state) => state.selectedModel);
  const {
    observationalMemory,
    semanticRecall,
    setObservationMessageTokens,
    setObservationalMemoryEnabled,
    setObservationalMemoryModelTarget,
    setObservationalMemoryScope,
    setObservationalRetrievalMode,
    setReflectionObservationTokens,
    setSemanticRecallEmbeddingModelTarget,
    setSemanticRecallEnabled,
    setSemanticRecallMessageRange,
    setSemanticRecallScope,
    setSemanticRecallTopK,
  } = useAssistantMemoryPreferencesStore();

  const observationOptions = listObservationalMemoryModelOptions({
    assistantMemoryBackendAvailable,
    models,
    ...(providerKeySources ? { providerKeySources } : {}),
    providers,
  });
  const embeddingOptions = listSemanticRecallEmbeddingModelOptions({
    models,
    ...(providerKeySources ? { providerKeySources } : {}),
    providers,
  });
  const isAutoObservationTarget =
    observationalMemory.modelTarget === OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET;
  const hasObservationModel =
    isAutoObservationTarget ||
    observationOptions.some((option) => option.target === observationalMemory.modelTarget);
  const hasEmbeddingModel =
    semanticRecall.embeddingModelTarget !== null &&
    embeddingOptions.some((option) => option.target === semanticRecall.embeddingModelTarget);
  const hasUnavailableEmbeddingModel =
    providerKeySources !== undefined &&
    hasLoaded &&
    semanticRecall.embeddingModelTarget !== null &&
    !hasEmbeddingModel;
  const hasUnavailableObservationModel =
    providerKeySources !== undefined && hasLoaded && !hasObservationModel;
  // Auto resolves an observer from the chat provider ONLY, and says so. A manual
  // target has no such constraint, so it can route the conversation to a second
  // provider silently — observed live with an openrouter chat observed by
  // openai/gpt-5.6-luna. Named explicitly rather than hinted, because the auto
  // copy makes a guarantee a reader would otherwise assume still holds.
  const crossProviderEgress = resolveCrossProviderObserverEgress({
    chatModelKey: selectedModel,
    isAutoObservationTarget,
    observerTarget: observationalMemory.modelTarget,
  });
  const canToggleObservations = hasObservationModel || observationalMemory.enabled;
  const canToggleSemanticRecall = hasEmbeddingModel || semanticRecall.enabled;

  return (
    <Card className="space-y-5 p-4" data-testid="assistant-memory-settings-section">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <BrainCircuit className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-medium text-sm">Assistant Memory</h3>
            <Badge variant="outline">Mastra</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Choose the explicit models Mastra uses for observations and semantic memory. Built-in
            Gemma remains on-device through the desktop renderer host.
          </p>
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
          crossProviderEgress={crossProviderEgress}
          hasObservationModel={hasObservationModel}
          hasUnavailableObservationModel={hasUnavailableObservationModel}
          isAutoObservationTarget={isAutoObservationTarget}
          modelTarget={observationalMemory.modelTarget}
          observationalMemoryEnabled={observationalMemory.enabled}
          observationOptions={observationOptions}
          onModelTargetChange={setObservationalMemoryModelTarget}
        />

        <div className="space-y-2">
          <Label htmlFor="assistant-memory-observation-scope">Observation scope</Label>
          <select
            aria-label="Observation scope"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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
          <p className="text-muted-foreground text-xs">
            Thread scope is the safe default; workspace scope observes across all workspace threads.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="assistant-memory-message-tokens">Observe messages after</Label>
          <Input
            aria-label="Observe messages after"
            defaultValue={observationalMemory.messageTokens}
            id="assistant-memory-message-tokens"
            min={1000}
            onChange={(event) => setObservationMessageTokens(parseNumberInput(event.target.value))}
            step={1000}
            type="number"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="assistant-memory-observation-tokens">Reflect observations after</Label>
          <Input
            aria-label="Reflect observations after"
            defaultValue={observationalMemory.observationTokens}
            id="assistant-memory-observation-tokens"
            min={1000}
            onChange={(event) =>
              setReflectionObservationTokens(parseNumberInput(event.target.value))
            }
            step={1000}
            type="number"
          />
        </div>

        <div className="space-y-2 md:col-span-2">
          <Label htmlFor="assistant-memory-retrieval-mode">Observation retrieval mode</Label>
          <select
            aria-label="Observation retrieval mode"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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
          <p className="text-muted-foreground text-xs">
            Vector retrieval requires semantic recall and an embedder. If enabled before the
            embedder bridge is configured, assistant startup fails explicitly.
          </p>
        </div>
      </div>

      <div className="border-border border-t pt-4">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h4 className="font-medium text-sm">Semantic Recall</h4>
            <p className="text-muted-foreground text-sm">
              {semanticRecall.enabled
                ? 'Semantic recall is on and requires the configured embedder at runtime.'
                : 'Semantic recall is off; conversation history still persists durably.'}
            </p>
          </div>
          <Switch
            aria-label="Enable semantic recall"
            checked={semanticRecall.enabled}
            disabled={!canToggleSemanticRecall}
            onCheckedChange={setSemanticRecallEnabled}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="assistant-memory-embedding-model">
              Semantic recall embedding model
            </Label>
            <select
              aria-label="Semantic recall embedding model"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              disabled={embeddingOptions.length === 0}
              id="assistant-memory-embedding-model"
              onChange={(event) => setSemanticRecallEmbeddingModelTarget(event.target.value)}
              value={hasEmbeddingModel ? (semanticRecall.embeddingModelTarget ?? '') : ''}
            >
              {!hasEmbeddingModel && <option value="">Select an enabled embedding model</option>}
              {embeddingOptions.map((option) => (
                <option key={option.target} value={option.target}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              Local embedding models run in the hidden embedding host on desktop — no API key
              required.
            </p>
            {hasUnavailableEmbeddingModel && (
              <p className="text-destructive text-xs" role="alert">
                Configured semantic recall embedder {semanticRecall.embeddingModelTarget} is not
                available for Mastra semantic recall. Choose an enabled OpenAI, Google, or local
                embedding model, or turn semantic recall off.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="assistant-memory-semantic-scope">Semantic recall scope</Label>
            <select
              aria-label="Semantic recall scope"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              id="assistant-memory-semantic-scope"
              onChange={(event) =>
                setSemanticRecallScope(event.target.value as RuntimeAssistantMemoryScope)
              }
              value={semanticRecall.scope}
            >
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {formatMemoryScopeLabel(scope)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="assistant-memory-semantic-top-k">Semantic matches</Label>
            <Input
              aria-label="Semantic matches"
              defaultValue={semanticRecall.topK}
              id="assistant-memory-semantic-top-k"
              max={50}
              min={1}
              onChange={(event) => setSemanticRecallTopK(parseNumberInput(event.target.value))}
              type="number"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="assistant-memory-semantic-message-range">Surrounding messages</Label>
            <Input
              aria-label="Surrounding messages"
              defaultValue={semanticRecall.messageRange}
              id="assistant-memory-semantic-message-range"
              max={20}
              min={0}
              onChange={(event) =>
                setSemanticRecallMessageRange(parseNumberInput(event.target.value))
              }
              type="number"
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
