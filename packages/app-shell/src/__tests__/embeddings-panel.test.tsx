import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { EmbeddingsPanel } from '../embeddings-panel';

// Mock the SimpleEmbeddingService
vi.mock('@brainstrike/embeddings', () => {
  const mockListModels = vi.fn(() => ({
    'jina-code': {
      id: 'jinaai/jina-embeddings-v3',
      name: 'Jina Code',
      dimensions: 768,
      quantized: false,
      description: 'Code-optimized embeddings',
      tags: ['code', 'default'],
      origin: 'Jina AI',
      size: '~300MB',
    },
    'all-MiniLM-L6-v2': {
      id: 'Xenova/all-MiniLM-L6-v2',
      name: 'all-MiniLM-L6-v2',
      dimensions: 384,
      quantized: true,
      description: 'General purpose embeddings',
      tags: ['general'],
      origin: 'Sentence Transformers',
      size: '~23MB',
    },
  }));

  const mockGetDefaultModelKey = vi.fn(() => 'jina-code');

  const MockSimpleEmbeddingService = vi.fn().mockImplementation(() => ({
    initializeWithModel: vi.fn(),
    generateEmbedding: vi.fn(),
    calculateSimilarity: vi.fn(),
    getStatus: vi.fn(),
    getConfig: vi.fn(),
    dispose: vi.fn(),
    getCurrentModelKey: vi.fn(),
    getCurrentModelConfig: vi.fn(),
  }));

  MockSimpleEmbeddingService.listModels = mockListModels;
  MockSimpleEmbeddingService.getDefaultModelKey = mockGetDefaultModelKey;

  return {
    SimpleEmbeddingService: MockSimpleEmbeddingService,
  };
});

describe('EmbeddingsPanel', () => {
  let mockService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { SimpleEmbeddingService } = await import('@brainstrike/embeddings');
    mockService = new SimpleEmbeddingService();
    
    // Set up default mock responses
    mockService.getStatus.mockReturnValue('idle');
    mockService.getConfig.mockReturnValue({
      modelId: 'jinaai/jina-embeddings-v3',
      device: 'webgpu',
      selectedDevice: 'webgpu'
    });
  });

  it('renders with initial state', () => {
    render(<EmbeddingsPanel />);
    
    expect(screen.getByText('Text Embeddings')).toBeInTheDocument();
    expect(screen.getByText('Not initialized')).toBeInTheDocument();
    expect(screen.getAllByText('Jina Code')[0]).toBeInTheDocument();
  });

  it('allows model selection', () => {
    render(<EmbeddingsPanel />);
    
    const selectTrigger = screen.getByRole('combobox');
    fireEvent.click(selectTrigger);
    
    const miniLMOption = screen.getAllByText('all-MiniLM-L6-v2')[0];
    fireEvent.click(miniLMOption);
    
    expect(screen.getAllByText('all-MiniLM-L6-v2')[0]).toBeInTheDocument();
  });

  it('has initialize model button', () => {
    render(<EmbeddingsPanel />);
    
    const initButton = screen.getByRole('button', { name: /Initialize Model/i });
    expect(initButton).toBeInTheDocument();
  });

  it('shows proper description', () => {
    render(<EmbeddingsPanel />);
    
    expect(screen.getByText('Generate embeddings and calculate text similarity')).toBeInTheDocument();
  });

  it('shows model info correctly', () => {
    render(<EmbeddingsPanel />);
    
    expect(screen.getByText('Model:')).toBeInTheDocument();
    expect(screen.getAllByText('Jina Code')[0]).toBeInTheDocument();
    expect(screen.getByText('Dimensions:')).toBeInTheDocument();
    expect(screen.getByText('768D')).toBeInTheDocument();
    expect(screen.getByText('Origin:')).toBeInTheDocument();
    expect(screen.getByText('Jina AI')).toBeInTheDocument();
    expect(screen.getByText('Size:')).toBeInTheDocument();
    expect(screen.getByText('~300MB')).toBeInTheDocument();
  });

  it('shows non-default badge for non-default models', () => {
    render(<EmbeddingsPanel />);
    
    // Switch to non-default model
    const selectTrigger = screen.getByRole('combobox');
    fireEvent.click(selectTrigger);
    
    const miniLMOption = screen.getAllByText('all-MiniLM-L6-v2')[0];
    fireEvent.click(miniLMOption);
    
    expect(screen.getByText('Non-default')).toBeInTheDocument();
  });
});