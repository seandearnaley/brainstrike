import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
} from '@brainstrike/assistant-contract/memory-settings';
import { usePGliteDatabase } from '@brainstrike/db';
import { Badge, Card, Input, Label, Switch } from '@brainstrike/ui';
import { BrainCircuit } from 'lucide-react';
import { useEnsureModelRegistry } from '../../hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '../../stores/assistant-memory-preferences-store';
import { useModelRegistryStore } from '../../stores/model-registry-store';
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

export function AssistantMemorySettingsSection() {
  const db = usePGliteDatabase();
  useEnsureModelRegistry({ db });

  const { models, providers } = useModelRegistryStore();
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

  const observationOptions = listObservationalMemoryModelOptions({ models, providers });
  const embeddingOptions = listSemanticRecallEmbeddingModelOptions({ models, providers });
  const hasObservationModel = observationOptions.some(
    (option) => option.target === observationalMemory.modelTarget
  );
  const hasEmbeddingModel =
    semanticRecall.embeddingModelTarget !== null &&
    embeddingOptions.some((option) => option.target === semanticRecall.embeddingModelTarget);
  const hasUnavailableEmbeddingModel =
    semanticRecall.embeddingModelTarget !== null && !hasEmbeddingModel;
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
            Gemma stays renderer-only and is not used for background observation jobs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="assistant-memory-observational-enabled">Enable observations</Label>
          <Switch
            aria-label="Enable observational memory"
            checked={observationalMemory.enabled}
            id="assistant-memory-observational-enabled"
            onCheckedChange={setObservationalMemoryEnabled}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="assistant-memory-observation-model">Observational memory model</Label>
          <select
            aria-label="Observational memory model"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            disabled={observationOptions.length === 0}
            id="assistant-memory-observation-model"
            onChange={(event) => setObservationalMemoryModelTarget(event.target.value)}
            value={hasObservationModel ? observationalMemory.modelTarget : ''}
          >
            {!hasObservationModel && <option value="">Select an enabled hosted LLM model</option>}
            {observationOptions.map((option) => (
              <option key={option.target} value={option.target}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Observers and reflectors use Mastra model routing strings like{' '}
            <span className="font-mono">openai/gpt-5.4-mini</span>.
          </p>
        </div>

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
