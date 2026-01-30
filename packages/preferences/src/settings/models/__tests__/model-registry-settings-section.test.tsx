import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToast } from '@brainstrike/ui';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../../../stores/model-registry-store';
import { ModelRegistrySettingsSection } from '../model-registry-settings-section';

// Mock imports
vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: vi.fn(() => ({})),
}));

vi.mock('@brainstrike/embeddings', () => {
  const MockService = vi.fn();
  MockService.prototype.downloadModel = vi.fn().mockRejectedValue(new Error('Network error'));
  return {
    SimpleEmbeddingService: MockService,
  };
});

vi.mock('@brainstrike/ui', () => {
  return {
    useToast: vi.fn(),
    Badge: ({ children, ...props }: any) => (
      <div data-testid="badge" {...props}>
        {children}
      </div>
    ),
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Card: ({ children, ...props }: any) => (
      <div data-testid="card" {...props}>
        {children}
      </div>
    ),
    Input: (props: any) => <input {...props} />,
    Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
    Progress: (props: any) => <div data-testid="progress" {...props} />,
    Switch: (props: any) => <input type="checkbox" role="switch" {...props} readOnly />,
  };
});

// Mock hooks
vi.mock('../../hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

describe('ModelRegistrySettingsSection', () => {
  const mockToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetModelRegistryStoreForTests();
    (useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ toast: mockToast });
  });

  it('shows error toast when download fails', async () => {
    // Setup store with one provider and one local model
    useModelRegistryStore.setState({
      providers: [
        {
          id: 'local',
          name: 'Local Provider',
          icon: null,
          isEnabled: true,
          sortOrder: 0,
        },
      ],
      models: [
        {
          id: 'test-model',
          providerId: 'local',
          name: 'Test Model',
          description: 'A test model',
          tagline: null,
          bestFor: null,
          icon: null,
          isEnabled: true,
          capabilities: { type: 'embedding', streaming: false },
          parameters: null,
          sortOrder: 0,
        },
      ],
      hasLoaded: true,
      isLoading: false,
      error: null,
    });

    render(<ModelRegistrySettingsSection />);

    // Expand the provider
    // The expand button is within the provider card.
    const providerText = screen.getByText('Local Provider');
    // Traverse up to find the container, then find the button.
    // The structure is: Card -> div -> Button (expand), div (text), div (switch)
    // We can assume the first button in the document (or near the top) might be it, but let's be more precise if possible.
    // Actually, screen.getAllByRole('button') is reliable if we know the order.
    // 1. Select Directory (folder icon)
    // 2. Refresh Registry (refresh icon)
    // 3. Expand Provider (chevron icon)

    const buttons = screen.getAllByRole('button');
    // We expect at least 3 buttons.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    const expandBtn = buttons[2];

    await userEvent.click(expandBtn);

    // Now model should be visible.
    expect(await screen.findByText('Test Model')).toBeTruthy();

    // Find "Download" button.
    const downloadBtn = screen.getByRole('button', { name: 'Download' });
    await userEvent.click(downloadBtn);

    // Verify toast
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Download Failed',
        description: 'Network error',
        variant: 'destructive',
      });
    });
  });
});
