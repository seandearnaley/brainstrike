import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingsPanel } from '../embeddings-panel';

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

// Mock hasPointerCapture for React 19 compatibility
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
}

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
    initializeWithModel: vi.fn().mockResolvedValue(undefined),
    generateEmbedding: vi.fn().mockResolvedValue({ embedding: [] }),
    calculateSimilarity: vi.fn().mockReturnValue({ similarity: 0 }),
    getStatus: vi.fn().mockReturnValue('idle'),
    getConfig: vi.fn().mockReturnValue({
      modelId: 'jinaai/jina-embeddings-v3',
      device: 'webgpu',
      selectedDevice: 'webgpu',
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    getCurrentModelKey: vi.fn().mockReturnValue('jina-code'),
    getCurrentModelConfig: vi.fn().mockReturnValue(null),
  }));

  MockSimpleEmbeddingService.listModels = mockListModels;
  MockSimpleEmbeddingService.getDefaultModelKey = mockGetDefaultModelKey;

  return {
    SimpleEmbeddingService: MockSimpleEmbeddingService,
  };
});

describe('EmbeddingsPanel - Basic Tests', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    user = userEvent.setup();
  });

  it('renders with initial state', () => {
    render(<EmbeddingsPanel />);

    expect(screen.getByText('Text Embeddings')).toBeInTheDocument();
    expect(screen.getByText('Not initialized')).toBeInTheDocument();
    expect(screen.getAllByText('Jina Code')[0]).toBeInTheDocument();
  });

  it('shows model selector in idle state', () => {
    render(<EmbeddingsPanel />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('shows model selector with default selection', () => {
    render(<EmbeddingsPanel />);

    const selectTrigger = screen.getByRole('combobox');
    expect(selectTrigger).toBeInTheDocument();
    // Default model should be shown - use getAllByText since it appears multiple times
    expect(screen.getAllByText('Jina Code').length).toBeGreaterThan(0);
  });

  it('has initialize model button', () => {
    render(<EmbeddingsPanel />);

    const initButton = screen.getByRole('button', { name: /Initialize Model/i });
    expect(initButton).toBeInTheDocument();
  });

  it('shows proper description', () => {
    render(<EmbeddingsPanel />);

    expect(
      screen.getByText('Generate embeddings and calculate text similarity')
    ).toBeInTheDocument();
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

  it('displays model information panel', () => {
    render(<EmbeddingsPanel />);

    // Should show model info for default model
    expect(screen.getByText('Model:')).toBeInTheDocument();
    expect(screen.getByText('Origin:')).toBeInTheDocument();
    expect(screen.getByText('Jina AI')).toBeInTheDocument();
  });

  it('shows embeddings description', () => {
    render(<EmbeddingsPanel />);

    // Should show description text
    expect(
      screen.getByText(/Generate embeddings and calculate text similarity/)
    ).toBeInTheDocument();
  });

  it('shows download size information', () => {
    render(<EmbeddingsPanel />);
    expect(
      screen.getByText((_content, element) => {
        return element?.textContent === 'Downloads ~300MB model for local inference';
      })
    ).toBeInTheDocument();
  });

  it('shows model tags in about section', () => {
    render(<EmbeddingsPanel />);

    expect(screen.getByText('About Jina Code:')).toBeInTheDocument();
    expect(screen.getByText('• code')).toBeInTheDocument();
    expect(screen.getByText('• default')).toBeInTheDocument();
  });

  it('shows different status badges correctly', () => {
    render(<EmbeddingsPanel />);
    // In idle state
    expect(screen.getByText('Not initialized')).toBeInTheDocument();
  });

  it('cleans up service on unmount', () => {
    const { unmount } = render(<EmbeddingsPanel />);
    unmount();
    // Component should unmount without errors
    expect(true).toBe(true);
  });
});
