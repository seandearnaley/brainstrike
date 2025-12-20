import {
  type EmbeddingStatus,
  type ModelConfig,
  SimpleEmbeddingService,
} from '@brainstrike/embeddings';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import { AlertCircle, Brain, Copy, Cpu, Square, Zap } from 'lucide-react';
import { useEffect } from 'react';
// no-op
import { useEmbeddingsPanelStore } from './stores/embeddings-panel-store';

// Get models from registry
const AVAILABLE_MODELS = SimpleEmbeddingService.listModels();
const DEFAULT_MODEL_KEY = SimpleEmbeddingService.getDefaultModelKey();

type ModelKey = string;

const getStatusColor = (status: EmbeddingStatus): 'default' | 'secondary' | 'destructive' => {
  switch (status) {
    case 'ready':
      return 'default';
    case 'processing':
      return 'secondary';
    case 'error':
      return 'destructive';
    default:
      return 'secondary';
  }
};

const getStatusText = (status: EmbeddingStatus): string => {
  switch (status) {
    case 'idle':
      return 'Not initialized';
    case 'initializing':
      return 'Initializing...';
    case 'downloading':
      return 'Downloading...';
    case 'ready':
      return 'Ready';
    case 'processing':
      return 'Processing...';
    case 'error':
      return 'Error';
    case 'disposed':
      return 'Disposed';
    default:
      return 'Unknown';
  }
};

const formatInitializationError = (error: unknown, modelName: string): string => {
  if (!(error instanceof Error)) {
    return 'Failed to initialize model';
  }

  if (error.message.includes('Failed to fetch')) {
    return `Network error loading ${modelName}. Check your internet connection or try a different model.`;
  }

  if (error.message.includes('external data format')) {
    return `${modelName} requires quantization. Please try again or use a different model.`;
  }

  return error.message;
};

type ModelInfoProps = {
  modelConfig: ModelConfig | undefined;
  isDefault: boolean;
};

const ModelInfo = ({ modelConfig, isDefault }: ModelInfoProps) => {
  if (!modelConfig) {
    return null;
  }

  return (
    <div className="rounded bg-muted/30 p-2 text-xs">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <p className="font-medium">Model:</p>
          <p className="text-muted-foreground">{modelConfig.name}</p>
        </div>
        <div>
          <p className="font-medium">Dimensions:</p>
          <p className="text-muted-foreground">{modelConfig.dimensions}D</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="font-medium">Origin:</p>
          <p className="text-muted-foreground">{modelConfig.origin}</p>
        </div>
        <div>
          <p className="font-medium">Size:</p>
          <p className="text-muted-foreground">{modelConfig.size}</p>
        </div>
      </div>
      {!isDefault && (
        <div className="mt-2 flex items-center gap-1">
          <Badge className="text-xs" variant="secondary">
            Non-default
          </Badge>
        </div>
      )}
    </div>
  );
};

type SimilarityInterfaceProps = {
  status: EmbeddingStatus;
  text1: string;
  text2: string;
  similarity: number | null;
  selectedDevice?: string;
  onText1Change: (value: string) => void;
  onText2Change: (value: string) => void;
  onCalculate: () => void;
  onDispose: () => void;
};

const SimilarityInterface = ({
  status,
  text1,
  text2,
  similarity,
  selectedDevice,
  onText1Change,
  onText2Change,
  onCalculate,
  onDispose,
}: SimilarityInterfaceProps) => {
  const { toast } = useToast();

  const handleCopySimilarity = async () => {
    if (similarity !== null) {
      try {
        await navigator.clipboard.writeText((similarity * 100).toFixed(3));
      } catch (error) {
        toast({
          title: 'Unable to copy similarity score',
          description: error instanceof Error ? error.message : 'Clipboard access is unavailable.',
          variant: 'destructive',
        });
      }
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label className="text-xs" htmlFor="text1">
          Text 1:
        </Label>
        <Input
          className="text-xs"
          disabled={status === 'processing'}
          id="text1"
          onChange={(e) => onText1Change(e.target.value)}
          placeholder="Enter first text..."
          value={text1}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs" htmlFor="text2">
          Text 2:
        </Label>
        <Input
          className="text-xs"
          disabled={status === 'processing'}
          id="text2"
          onChange={(e) => onText2Change(e.target.value)}
          placeholder="Enter second text..."
          value={text2}
        />
      </div>

      <Button
        className="w-full gap-2"
        disabled={status === 'processing' || !text1.trim() || !text2.trim()}
        onClick={onCalculate}
        size="sm"
      >
        <Cpu className="h-3 w-3" />
        {status === 'processing' ? 'Processing...' : 'Calculate Similarity'}
      </Button>

      {similarity !== null && (
        <div className="rounded border border-blue-200 bg-blue-50 p-2">
          <div className="mb-1 flex items-center justify-between">
            <p className="font-medium">Similarity Score:</p>
            <Button
              className="h-auto p-1"
              onClick={handleCopySimilarity}
              size="sm"
              title="Copy similarity score"
              variant="ghost"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
          <p className="font-bold text-blue-600 text-lg">{(similarity * 100).toFixed(1)}%</p>
          <p className="mt-1 text-muted-foreground">
            {similarity > 0.7
              ? 'Very similar'
              : similarity > 0.5
                ? 'Moderately similar'
                : similarity > 0.3
                  ? 'Somewhat similar'
                  : 'Not very similar'}
          </p>
          {selectedDevice && (
            <p className="mt-1 text-muted-foreground text-xs">
              Computed on: {selectedDevice.toUpperCase()}
            </p>
          )}
        </div>
      )}

      <Button className="w-full gap-2" onClick={onDispose} size="sm" variant="outline">
        <Square className="h-3 w-3" />
        Dispose Model
      </Button>
    </div>
  );
};

export function EmbeddingsPanel() {
  const [
    status,
    progress,
    progressMessage,
    selectedModel,
    text1,
    text2,
    similarity,
    selectedDevice,
    error,
  ] = useEmbeddingsPanelStore((s) => [
    s.status,
    s.progress,
    s.progressMessage,
    s.selectedModel,
    s.text1,
    s.text2,
    s.similarity,
    s.selectedDevice,
    s.error,
  ]);
  const setSelectedModel = useEmbeddingsPanelStore((s) => s.setSelectedModel);
  const setText1 = useEmbeddingsPanelStore((s) => s.setText1);
  const setText2 = useEmbeddingsPanelStore((s) => s.setText2);
  const initialize = useEmbeddingsPanelStore((s) => s.initialize);
  const calculateSimilarity = useEmbeddingsPanelStore((s) => s.calculateSimilarity);
  const dispose = useEmbeddingsPanelStore((s) => s.dispose);

  const handleModelChange = (newModel: ModelKey) => {
    if (status !== 'idle') {
      // If a model is already loaded, show warning
      useEmbeddingsPanelStore.setState({
        error: 'Please dispose the current model before switching',
      });
      return;
    }
    setSelectedModel(newModel);
    useEmbeddingsPanelStore.setState({ error: null });
  };

  const handleInitialize = async () => {
    await initialize();
    // Translate any raw error to a nicer message if present
    const e = useEmbeddingsPanelStore.getState().error;
    if (e) {
      const currentModel = AVAILABLE_MODELS[selectedModel];
      const errorMessage = formatInitializationError(e, currentModel?.name || selectedModel);
      useEmbeddingsPanelStore.setState({ error: errorMessage });
    }
  };

  const handleCalculateSimilarity = async () => {
    await calculateSimilarity();
  };

  const handleDispose = async () => {
    await dispose();
  };

  // Ensure the embedding service is disposed when the panel unmounts
  // to prevent leaking GPU/CPU resources across navigation or tab hides.
  // The store's dispose() is idempotent and safe to call when idle.
  useEffect(
    () => () => {
      void dispose();
    },
    [dispose]
  );

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Brain className="h-4 w-4" />
              Embedding Playground
            </CardTitle>
            <CardDescription className="text-xs">
              Test individual models and similarity (not tied to your vector DB)
            </CardDescription>
          </div>
          <Badge className="text-xs" variant={getStatusColor(status)}>
            {getStatusText(status)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        {/* Model Selector */}
        {status === 'idle' && (
          <div className="space-y-2">
            <Label className="text-xs" htmlFor="model-select">
              Select Model:
            </Label>
            <Select
              onValueChange={(value) => handleModelChange(value as ModelKey)}
              value={selectedModel}
            >
              <SelectTrigger className="text-xs" id="model-select">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AVAILABLE_MODELS).map(([key, model]) => (
                  <SelectItem className="text-xs" key={key} value={key}>
                    <div>
                      <div className="font-medium">{model.name}</div>
                      <div className="text-muted-foreground text-xs">{model.description}</div>
                      <div className="text-muted-foreground text-xs">
                        {model.dimensions}D • {model.size}
                      </div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {AVAILABLE_MODELS[selectedModel]?.quantized && (
              <div className="rounded border border-orange-200 bg-orange-50 p-2 text-xs">
                <p className="font-medium text-orange-800">Note:</p>
                <p className="text-orange-700">
                  This model uses quantization for stability in browsers.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Model Info */}
        <ModelInfo
          isDefault={selectedModel === DEFAULT_MODEL_KEY}
          modelConfig={AVAILABLE_MODELS[selectedModel]}
        />

        {/* Error Display */}
        {error && (
          <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-2">
            <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-500" />
            <div>
              <p className="font-medium text-red-800">Error:</p>
              <p className="text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Initialization */}
        {status === 'idle' && (
          <div className="space-y-2">
            <Button className="w-full gap-2" onClick={handleInitialize} size="sm">
              <Zap className="h-3 w-3" />
              Initialize Model
            </Button>
            <p className="text-muted-foreground text-xs">
              Downloads {AVAILABLE_MODELS[selectedModel]?.size || '~??MB'} model for local inference
            </p>
          </div>
        )}

        {/* Progress */}
        {(status === 'initializing' || status === 'downloading') && (
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>{progressMessage || 'Loading...'}</span>
              <span>{progress.toFixed(0)}%</span>
            </div>
            <Progress className="h-1" value={progress} />
          </div>
        )}

        {/* Main Interface */}
        {(status === 'ready' || status === 'processing') && (
          <SimilarityInterface
            similarity={similarity}
            status={status}
            text1={text1}
            text2={text2}
            {...(selectedDevice && { selectedDevice })}
            onCalculate={handleCalculateSimilarity}
            onDispose={handleDispose}
            onText1Change={setText1}
            onText2Change={setText2}
          />
        )}

        {/* Info */}
        <div className="rounded bg-muted/30 p-2 text-xs">
          <p className="mb-1 font-medium">About {AVAILABLE_MODELS[selectedModel]?.name}:</p>
          <ul className="space-y-1 text-muted-foreground">
            {AVAILABLE_MODELS[selectedModel]?.tags.map((tag) => (
              <li key={tag}>• {tag}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
