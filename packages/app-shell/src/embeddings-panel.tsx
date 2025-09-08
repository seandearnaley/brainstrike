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

interface ModelInfoProps {
  modelConfig: ModelConfig | undefined;
  isDefault: boolean;
}

const ModelInfo = ({ modelConfig, isDefault }: ModelInfoProps) => {
  if (!modelConfig) return null;

  return (
    <div className="p-2 bg-muted/30 rounded text-xs">
      <div className="grid grid-cols-2 gap-2 mb-2">
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
          <Badge variant="secondary" className="text-xs">
            Non-default
          </Badge>
        </div>
      )}
    </div>
  );
};

interface SimilarityInterfaceProps {
  status: EmbeddingStatus;
  text1: string;
  text2: string;
  similarity: number | null;
  selectedDevice?: string;
  onText1Change: (value: string) => void;
  onText2Change: (value: string) => void;
  onCalculate: () => void;
  onDispose: () => void;
}

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
  const handleCopySimilarity = async () => {
    if (similarity !== null) {
      try {
        await navigator.clipboard.writeText((similarity * 100).toFixed(3));
      } catch (_error) {}
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="text1" className="text-xs">
          Text 1:
        </Label>
        <Input
          id="text1"
          value={text1}
          onChange={(e) => onText1Change(e.target.value)}
          className="text-xs"
          placeholder="Enter first text..."
          disabled={status === 'processing'}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="text2" className="text-xs">
          Text 2:
        </Label>
        <Input
          id="text2"
          value={text2}
          onChange={(e) => onText2Change(e.target.value)}
          className="text-xs"
          placeholder="Enter second text..."
          disabled={status === 'processing'}
        />
      </div>

      <Button
        onClick={onCalculate}
        size="sm"
        className="w-full gap-2"
        disabled={status === 'processing' || !text1.trim() || !text2.trim()}
      >
        <Cpu className="w-3 h-3" />
        {status === 'processing' ? 'Processing...' : 'Calculate Similarity'}
      </Button>

      {similarity !== null && (
        <div className="p-2 bg-blue-50 border border-blue-200 rounded">
          <div className="flex items-center justify-between mb-1">
            <p className="font-medium">Similarity Score:</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopySimilarity}
              className="h-auto p-1"
              title="Copy similarity score"
            >
              <Copy className="w-3 h-3" />
            </Button>
          </div>
          <p className="text-lg font-bold text-blue-600">{(similarity * 100).toFixed(1)}%</p>
          <p className="text-muted-foreground mt-1">
            {similarity > 0.7
              ? 'Very similar'
              : similarity > 0.5
                ? 'Moderately similar'
                : similarity > 0.3
                  ? 'Somewhat similar'
                  : 'Not very similar'}
          </p>
          {selectedDevice && (
            <p className="text-xs text-muted-foreground mt-1">
              Computed on: {selectedDevice.toUpperCase()}
            </p>
          )}
        </div>
      )}

      <Button onClick={onDispose} size="sm" variant="outline" className="w-full gap-2">
        <Square className="w-3 h-3" />
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
  useEffect(() => {
    return () => {
      void dispose();
    };
  }, [dispose]);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <Brain className="w-4 h-4" />
              Text Embeddings
            </CardTitle>
            <CardDescription className="text-xs">
              Generate embeddings and calculate text similarity
            </CardDescription>
          </div>
          <Badge variant={getStatusColor(status)} className="text-xs">
            {getStatusText(status)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="text-xs space-y-3">
        {/* Model Selector */}
        {status === 'idle' && (
          <div className="space-y-2">
            <Label htmlFor="model-select" className="text-xs">
              Select Model:
            </Label>
            <Select
              value={selectedModel}
              onValueChange={(value) => handleModelChange(value as ModelKey)}
            >
              <SelectTrigger id="model-select" className="text-xs">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AVAILABLE_MODELS).map(([key, model]) => (
                  <SelectItem key={key} value={key} className="text-xs">
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
              <div className="p-2 bg-orange-50 border border-orange-200 rounded text-xs">
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
          modelConfig={AVAILABLE_MODELS[selectedModel]}
          isDefault={selectedModel === DEFAULT_MODEL_KEY}
        />

        {/* Error Display */}
        {error && (
          <div className="p-2 bg-red-50 border border-red-200 rounded flex items-start gap-2">
            <AlertCircle className="w-3 h-3 text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-red-800">Error:</p>
              <p className="text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Initialization */}
        {status === 'idle' && (
          <div className="space-y-2">
            <Button onClick={handleInitialize} size="sm" className="w-full gap-2">
              <Zap className="w-3 h-3" />
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
            <Progress value={progress} className="h-1" />
          </div>
        )}

        {/* Main Interface */}
        {(status === 'ready' || status === 'processing') && (
          <SimilarityInterface
            status={status}
            text1={text1}
            text2={text2}
            similarity={similarity}
            {...(selectedDevice && { selectedDevice })}
            onText1Change={setText1}
            onText2Change={setText2}
            onCalculate={handleCalculateSimilarity}
            onDispose={handleDispose}
          />
        )}

        {/* Info */}
        <div className="p-2 bg-muted/30 rounded text-xs">
          <p className="font-medium mb-1">About {AVAILABLE_MODELS[selectedModel]?.name}:</p>
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
