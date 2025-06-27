import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui/card';
import { Button } from '@brainstrike/ui/button';
import { Input } from '@brainstrike/ui/input';
import { Label } from '@brainstrike/ui/label';
import { Progress } from '@brainstrike/ui/progress';
import { Badge } from '@brainstrike/ui/badge';
import { AlertCircle, Brain, Zap } from 'lucide-react';

import { SimpleEmbeddingService } from './bge-m3-service';
import type { EmbeddingStatus, EmbeddingProgress, EmbeddingResult } from './types';

interface EmbeddingPanelProps {
  className?: string;
}

export function EmbeddingPanel({ className }: EmbeddingPanelProps) {
  const [status, setStatus] = useState<EmbeddingStatus>('idle');
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [compareText, setCompareText] = useState('');
  const [embedding, setEmbedding] = useState<EmbeddingResult | null>(null);
  const [compareEmbedding, setCompareEmbedding] = useState<EmbeddingResult | null>(null);
  const [similarity, setSimilarity] = useState<number | null>(null);

  const serviceRef = useRef<SimpleEmbeddingService | null>(null);

  const handleInitialize = useCallback(async () => {
    try {
      setError(null);
      setStatus('initializing');

      serviceRef.current = new SimpleEmbeddingService();

      await serviceRef.current.initialize(
        {
          modelId: 'Xenova/all-MiniLM-L6-v2',
          device: 'webgpu',
          quantized: true,
        },
        (progressInfo) => {
          setProgress(progressInfo);
        }
      );

      setStatus('ready');
      setProgress(null);
    } catch (err) {
      console.error('Failed to initialize:', err);
      setError(err instanceof Error ? err.message : 'Failed to initialize model');
      setStatus('error');
      setProgress(null);
    }
  }, []);

  const handleGenerateEmbedding = useCallback(async () => {
    if (!serviceRef.current || !inputText.trim()) return;

    try {
      setError(null);
      const result = await serviceRef.current.generateEmbedding(inputText.trim());
      setEmbedding(result);
    } catch (err) {
      console.error('Failed to generate embedding:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate embedding');
    }
  }, [inputText]);

  const handleGenerateCompareEmbedding = useCallback(async () => {
    if (!serviceRef.current || !compareText.trim()) return;

    try {
      setError(null);
      const result = await serviceRef.current.generateEmbedding(compareText.trim());
      setCompareEmbedding(result);
    } catch (err) {
      console.error('Failed to generate compare embedding:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate compare embedding');
    }
  }, [compareText]);

  const handleCalculateSimilarity = useCallback(() => {
    if (!serviceRef.current || !embedding || !compareEmbedding) return;

    try {
      setError(null);
      const result = serviceRef.current.calculateSimilarity(
        embedding.embedding,
        compareEmbedding.embedding
      );
      setSimilarity(result.similarity);
    } catch (err) {
      console.error('Failed to calculate similarity:', err);
      setError(err instanceof Error ? err.message : 'Failed to calculate similarity');
    }
  }, [embedding, compareEmbedding]);

  const getStatusColor = (status: EmbeddingStatus) => {
    switch (status) {
      case 'ready':
        return 'bg-green-500';
      case 'initializing':
        return 'bg-yellow-500';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getStatusText = (status: EmbeddingStatus) => {
    switch (status) {
      case 'idle':
        return 'Not initialized';
      case 'initializing':
        return 'Initializing...';
      case 'ready':
        return 'Ready';
      case 'error':
        return 'Error';
      default:
        return status;
    }
  };

  return (
    <div className={className}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Embeddings
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${getStatusColor(status)}`} />
              {getStatusText(status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span>{progress.message}</span>
                <span>{progress.progress}%</span>
              </div>
              <Progress value={progress.progress} />
            </div>
          )}

          {status === 'idle' && (
            <Button onClick={handleInitialize} className="w-full">
              <Zap className="h-4 w-4 mr-2" />
              Initialize Model
            </Button>
          )}

          {status === 'ready' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="input-text">Text to embed:</Label>
                <Input
                  id="input-text"
                  value={inputText}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setInputText(e.target.value)
                  }
                  placeholder="Enter text to generate embedding..."
                />
                <Button onClick={handleGenerateEmbedding} disabled={!inputText.trim()} size="sm">
                  Generate Embedding
                </Button>
              </div>

              {embedding && (
                <div className="p-3 bg-muted rounded-lg">
                  <div className="text-sm font-medium mb-1">Embedding Generated</div>
                  <div className="text-xs text-muted-foreground">
                    Dimensions: {embedding.dimensions} | Model: {embedding.model}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    First 5 values: [
                    {embedding.embedding
                      .slice(0, 5)
                      .map((v) => v.toFixed(3))
                      .join(', ')}
                    ...]
                  </div>
                </div>
              )}

              <div className="border-t pt-4">
                <div className="space-y-2">
                  <Label htmlFor="compare-text">Compare with:</Label>
                  <Input
                    id="compare-text"
                    value={compareText}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setCompareText(e.target.value)
                    }
                    placeholder="Enter text to compare similarity..."
                  />
                  <Button
                    onClick={handleGenerateCompareEmbedding}
                    disabled={!compareText.trim()}
                    size="sm"
                  >
                    Generate Compare Embedding
                  </Button>
                </div>

                {compareEmbedding && (
                  <div className="p-3 bg-muted rounded-lg mt-2">
                    <div className="text-sm font-medium mb-1">Compare Embedding Generated</div>
                    <div className="text-xs text-muted-foreground">
                      Dimensions: {compareEmbedding.dimensions} | Model: {compareEmbedding.model}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      First 5 values: [
                      {compareEmbedding.embedding
                        .slice(0, 5)
                        .map((v) => v.toFixed(3))
                        .join(', ')}
                      ...]
                    </div>
                  </div>
                )}

                {embedding && compareEmbedding && (
                  <div className="space-y-2 mt-4">
                    <Button
                      onClick={handleCalculateSimilarity}
                      className="w-full"
                      variant="outline"
                    >
                      Calculate Similarity
                    </Button>

                    {similarity !== null && (
                      <div className="p-3 bg-muted rounded-lg">
                        <div className="text-sm font-medium mb-1">Similarity Score</div>
                        <div className="text-lg font-bold">{(similarity * 100).toFixed(1)}%</div>
                        <div className="text-xs text-muted-foreground">
                          Cosine similarity: {similarity.toFixed(4)}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
