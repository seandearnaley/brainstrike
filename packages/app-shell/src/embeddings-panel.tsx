import { useState, useEffect, useRef } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Progress,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { Brain, Cpu, Zap, Square, AlertCircle } from 'lucide-react';
import {
  SimpleEmbeddingService,
  type EmbeddingStatus,
  type EmbeddingConfig,
} from '@brainstrike/embeddings';

// Model configurations
const AVAILABLE_MODELS = {
  'all-MiniLM-L6-v2': {
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2',
    description: 'Fast and efficient English embeddings',
    dimensions: 384,
    size: '~23MB',
    requiresQuantization: false,
    features: [
      'English language optimized',
      '384-dimensional embeddings',
      'Fast and efficient (~23MB)',
      'Great for semantic similarity',
      'WebGPU + WASM support',
    ],
  },
  'bge-small-en-v1.5': {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'BGE-Small-EN-v1.5',
    description: 'Balanced English embeddings',
    dimensions: 384,
    size: '~67MB',
    requiresQuantization: false,
    features: [
      'English language specialized',
      '384-dimensional embeddings',
      'High-quality retrieval',
      'Balanced speed/quality',
      'WebGPU + WASM support',
    ],
  },
  'bge-base-en-v1.5': {
    id: 'Xenova/bge-base-en-v1.5',
    name: 'BGE-Base-EN-v1.5',
    description: 'High-quality English embeddings',
    dimensions: 768,
    size: '~130MB',
    requiresQuantization: false,
    features: [
      'English language specialized',
      '768-dimensional embeddings',
      'Excellent retrieval quality',
      'BAAI state-of-the-art',
      'WebGPU + WASM support',
    ],
  },
  'bge-m3': {
    id: 'Xenova/bge-m3',
    name: 'BGE-M3 (Quantized)',
    description: 'Multilingual top-tier embeddings',
    dimensions: 1024,
    size: '~550MB',
    requiresQuantization: true,
    features: [
      'Multilingual (100+ languages)',
      '1024-dimensional embeddings',
      'Dense + sparse + ColBERT',
      'Top-tier retrieval quality',
      'Quantized for stability',
    ],
  },
} as const;

type ModelKey = keyof typeof AVAILABLE_MODELS;

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

export function EmbeddingsPanel() {
  const [status, setStatus] = useState<EmbeddingStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [selectedModel, setSelectedModel] = useState<ModelKey>('all-MiniLM-L6-v2');
  const [text1, setText1] = useState('Hello world, this is a test sentence.');
  const [text2, setText2] = useState('Hi there, this is another test phrase.');
  const [similarity, setSimilarity] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serviceRef = useRef<SimpleEmbeddingService | null>(null);
  
  // Debug logging for status changes
  useEffect(() => {
    console.log('[EmbeddingsPanel] Status changed to:', status);
  }, [status]);

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
      console.log('[EmbeddingsPanel] Starting initialization with model:', selectedModel);
      setStatus('initializing');
      setError(null);
      
      const modelConfig = AVAILABLE_MODELS[selectedModel];
      const config: Partial<EmbeddingConfig> = {
        modelId: modelConfig.id,
        device: 'webgpu', // Try WebGPU first, will fallback to WASM
        quantized: modelConfig.requiresQuantization || true, // Force quantization for BGE-M3, optional for others
      };

      await serviceRef.current.initialize(config, (progressInfo) => {
        console.log('[EmbeddingsPanel] Progress:', progressInfo);
        setProgress(progressInfo.progress || 0);
        setProgressMessage(progressInfo.message || '');
        
        // Update status based on progress stage
        if (progressInfo.stage === 'downloading') {
          setStatus('downloading');
        }
      });
      
      // After successful initialization, set status to ready
      const serviceStatus = serviceRef.current.getStatus();
      console.log('[EmbeddingsPanel] Service status after init:', serviceStatus);
      setStatus('ready');
      setProgress(100);
      console.log('[EmbeddingsPanel] Initialization complete, status set to ready');
    } catch (err) {
      console.error('Failed to initialize model:', err);
      const currentModel = AVAILABLE_MODELS[selectedModel];
      let errorMessage = 'Failed to initialize model';
      
      if (err instanceof Error) {
        if (err.message.includes('Failed to fetch')) {
          errorMessage = `Network error loading ${currentModel.name}. Check your internet connection or try a different model.`;
        } else if (err.message.includes('external data format')) {
          errorMessage = `${currentModel.name} requires quantization. Please try again or use a different model.`;
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
      setStatus('error');
    }
  };

  const handleCalculateSimilarity = async () => {
    if (!serviceRef.current || status !== 'ready' || !text1.trim() || !text2.trim()) {
      console.log('[EmbeddingsPanel] Cannot calculate similarity:', {
        hasService: !!serviceRef.current,
        status,
        hasText1: !!text1.trim(),
        hasText2: !!text2.trim()
      });
      return;
    }

    try {
      console.log('[EmbeddingsPanel] Calculating similarity...');
      setStatus('processing');
      setError(null);
      setSimilarity(null);

      console.log('[EmbeddingsPanel] Generating embedding for text1:', text1.substring(0, 50) + '...');
      const result1 = await serviceRef.current.generateEmbedding(text1.trim());
      
      console.log('[EmbeddingsPanel] Generating embedding for text2:', text2.substring(0, 50) + '...');
      const result2 = await serviceRef.current.generateEmbedding(text2.trim());

      console.log('[EmbeddingsPanel] Calculating cosine similarity...');
      const simResult = serviceRef.current.calculateSimilarity(
        result1.embedding,
        result2.embedding
      );
      setSimilarity(simResult.similarity);
      setStatus('ready');
      console.log('[EmbeddingsPanel] Similarity calculated:', simResult.similarity);
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
      console.log('[EmbeddingsPanel] Disposing service...');
      await serviceRef.current.dispose();
      setStatus('idle');
      setSimilarity(null);
      setProgress(0);
      setProgressMessage('');
      setError(null);
      console.log('[EmbeddingsPanel] Service disposed, status reset to idle');
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
            <Select value={selectedModel} onValueChange={(value) => handleModelChange(value as ModelKey)}>
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
            {AVAILABLE_MODELS[selectedModel].requiresQuantization && (
              <div className="p-2 bg-orange-50 border border-orange-200 rounded text-xs">
                <p className="font-medium text-orange-800">Note:</p>
                <p className="text-orange-700">
                  This model requires quantization for stability in browsers.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Model Info */}
        <div className="p-2 bg-muted/30 rounded text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="font-medium">Model:</p>
              <p className="text-muted-foreground">{AVAILABLE_MODELS[selectedModel].name}</p>
            </div>
            <div>
              <p className="font-medium">Dimensions:</p>
              <p className="text-muted-foreground">{AVAILABLE_MODELS[selectedModel].dimensions}D</p>
            </div>
          </div>
        </div>

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
              Downloads {AVAILABLE_MODELS[selectedModel].size} model for local inference
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
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="text1" className="text-xs">
                Text 1:
              </Label>
              <Input
                id="text1"
                value={text1}
                onChange={(e) => setText1(e.target.value)}
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
                onChange={(e) => setText2(e.target.value)}
                className="text-xs"
                placeholder="Enter second text..."
                disabled={status === 'processing'}
              />
            </div>

            <Button
              onClick={handleCalculateSimilarity}
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

            <Button onClick={handleDispose} size="sm" variant="outline" className="w-full gap-2">
              <Square className="w-3 h-3" />
              Dispose Model
            </Button>
          </div>
        )}

        {/* Info */}
        <div className="p-2 bg-muted/30 rounded text-xs">
          <p className="font-medium mb-1">About {AVAILABLE_MODELS[selectedModel].name}:</p>
          <ul className="space-y-1 text-muted-foreground">
            {AVAILABLE_MODELS[selectedModel].features.map((feature, index) => (
              <li key={index}>• {feature}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
