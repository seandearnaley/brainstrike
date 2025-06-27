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
import { AlertCircle, Brain, Cpu, Square, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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
  onText1Change,
  onText2Change,
  onCalculate,
  onDispose,
}: SimilarityInterfaceProps) => (
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
        <p className="font-medium">Similarity Score:</p>
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
      </div>
    )}

    <Button onClick={onDispose} size="sm" variant="outline" className="w-full gap-2">
      <Square className="w-3 h-3" />
      Dispose Model
    </Button>
  </div>
);

export function EmbeddingsPanel() {
  const [status, setStatus] = useState<EmbeddingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [selectedModel, setSelectedModel] = useState<ModelKey>(DEFAULT_MODEL_KEY);
  const [text1, setText1] = useState('Hello world, this is a test sentence.');
  const [text2, setText2] = useState('Hi there, this is another test phrase.');
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serviceRef = useRef<SimpleEmbeddingService | null>(null);

  // Debug logging for status changes
  useEffect(() => {}, []);

  useEffect(() => {
    // Initialize the service
    const service = new SimpleEmbeddingService();
    serviceRef.current = service;

    return () => {
      service.dispose();
    };
  }, []);

  const handleModelChange = (newModel: ModelKey) => {
    if (status !== 'idle') {
      // If a model is already loaded, show warning
      setError('Please dispose the current model before switching');
      return;
    }
    setSelectedModel(newModel);
    setError(null);
  };

  const handleInitialize = async () => {
    if (!serviceRef.current) return;

    try {
      setStatus('initializing');
      setError(null);

      // Use the new registry-aware initialization method
      await serviceRef.current.initializeWithModel(selectedModel, (progressInfo) => {
        setProgress(progressInfo.progress || 0);
        setProgressMessage(progressInfo.message || '');

        // Update status based on progress stage
        if (progressInfo.stage === 'downloading') {
          setStatus('downloading');
        }
      });

      // After successful initialization, set status to ready
      setStatus('ready');
      setProgress(100);
    } catch (err) {
      console.error('Failed to initialize model:', err);
      const currentModel = AVAILABLE_MODELS[selectedModel];
      const errorMessage = formatInitializationError(err, currentModel?.name || selectedModel);
      setError(errorMessage);
      setStatus('error');
    }
  };

  const handleCalculateSimilarity = async () => {
    if (!serviceRef.current || status !== 'ready' || !text1.trim() || !text2.trim()) {
      return;
    }

    try {
      setStatus('processing');
      setError(null);
      setSimilarity(null);
      const result1 = await serviceRef.current.generateEmbedding(text1.trim());
      const result2 = await serviceRef.current.generateEmbedding(text2.trim());
      const simResult = serviceRef.current.calculateSimilarity(
        result1.embedding,
        result2.embedding
      );
      setSimilarity(simResult.similarity);
      setStatus('ready');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to calculate similarity';
      setError(errorMessage);
      setStatus('ready');
      console.error('Failed to calculate similarity:', err);
    }
  };

  const handleDispose = async () => {
    if (!serviceRef.current) return;

    try {
      await serviceRef.current.dispose();
      setStatus('idle');
      setSimilarity(null);
      setProgress(0);
      setProgressMessage('');
      setError(null);
    } catch (err) {
      console.error('Failed to dispose service:', err);
    }
  };

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
