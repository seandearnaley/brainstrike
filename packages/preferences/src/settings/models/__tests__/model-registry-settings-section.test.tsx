import { useToast } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../../../stores/model-registry-store';
import { ModelRegistrySettingsSection } from '../model-registry-settings-section';
import {
  configureModelRuntimeServices,
  type ModelRuntimeServices,
} from '../model-runtime-services';

const {
  useBrainstrikeDbClientMock,
  useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReportMock,
} = vi.hoisted(() => ({
  useBrainstrikeDbClientMock: vi.fn(),
  useModelRegistryDbClientMock: vi.fn(),
  useOptionalProfileBootstrapReportMock: vi.fn(),
}));

// Mock imports
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeDbClient: useBrainstrikeDbClientMock,
  useModelRegistryDbClient: useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReport: useOptionalProfileBootstrapReportMock,
}));

vi.mock('../../../hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/ui', () => {
  interface MockComponentProps {
    children?: React.ReactNode;
    [key: string]: unknown;
  }

  return {
    useToast: vi.fn(),
    Badge: ({ children, ...props }: MockComponentProps) => (
      <div data-testid="badge" {...props}>
        {children}
      </div>
    ),
    Button: ({ children, ...props }: MockComponentProps) => <button {...props}>{children}</button>,
    Card: ({ children, ...props }: MockComponentProps) => (
      <div data-testid="card" {...props}>
        {children}
      </div>
    ),
    Input: (props: MockComponentProps) => <input {...props} />,
    Label: ({ children, ...props }: MockComponentProps) => (
      <label htmlFor="test-id" {...props}>
        {children}
      </label>
    ),
    Progress: (props: MockComponentProps) => <div data-testid="progress" {...props} />,
    Switch: ({ onCheckedChange, ...props }: MockComponentProps) => (
      <input
        aria-checked={props['checked'] === true}
        onChange={(event) => {
          if (typeof onCheckedChange === 'function') {
            onCheckedChange((event.target as HTMLInputElement).checked);
          }
        }}
        role="switch"
        type="checkbox"
        {...props}
      />
    ),
  };
});

describe('ModelRegistrySettingsSection', () => {
  const mockToast = vi.fn();
  let downloadEmbeddingModelMock: ReturnType<
    typeof vi.fn<ModelRuntimeServices['downloadEmbeddingModel']>
  >;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetModelRegistryStoreForTests();
    useBrainstrikeDbClientMock.mockReturnValue(null);
    useModelRegistryDbClientMock.mockReturnValue({ runtime: 'turso-registry' });
    useOptionalProfileBootstrapReportMock.mockReturnValue({ runtime: { engine: 'turso' } });
    downloadEmbeddingModelMock = vi
      .fn<ModelRuntimeServices['downloadEmbeddingModel']>()
      .mockRejectedValue(new Error('Network error'));
    configureModelRuntimeServices({
      downloadEmbeddingModel: downloadEmbeddingModelMock,
    });
    (useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ toast: mockToast });
  });

  const setupStore = () => {
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
  };

  it('shows error toast when download fails', async () => {
    setupStore();
    render(<ModelRegistrySettingsSection />);

    const expandBtn = screen.getByRole('button', { name: /Expand Local Provider/i });
    await userEvent.click(expandBtn);

    expect(await screen.findByText('Test Model')).toBeTruthy();

    const downloadBtn = screen.getByRole('button', { name: 'Download' });
    await userEvent.click(downloadBtn);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Download Failed',
        description: 'Network error',
        variant: 'destructive',
      });
    });
  });

  it('successfully downloads a model', async () => {
    const mockDownload = vi.fn().mockResolvedValue(undefined);
    configureModelRuntimeServices({
      downloadEmbeddingModel: mockDownload,
    });

    setupStore();
    render(<ModelRegistrySettingsSection />);

    const expandBtn = screen.getByRole('button', { name: /Expand Local Provider/i });
    await userEvent.click(expandBtn);

    const downloadBtn = screen.getByRole('button', { name: 'Download' });
    await userEvent.click(downloadBtn);

    await waitFor(() => {
      expect(mockDownload).toHaveBeenCalledWith(
        'test-model',
        expect.objectContaining({
          onProgress: expect.any(Function),
        })
      );
    });

    // We can't easily assert on the state update inside the component from here without checking UI changes,
    // but verifying the service call is sufficient for the "successful invocation" path.
    // The UI should theoretically show "Downloading" and progress, but since the mock resolves immediately,
    // it might be too fast to catch intermediate states in this test setup.
    // However, we can check that no error toast was shown.
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('labels active model download progress with the model name', async () => {
    setupStore();
    useModelRegistryStore.setState({
      downloadProgress: {
        'test-model': 42,
      },
      isDownloading: {
        'test-model': true,
      },
    });

    render(<ModelRegistrySettingsSection />);

    const expandBtn = screen.getByRole('button', { name: /Expand Local Provider/i });
    await userEvent.click(expandBtn);

    expect(screen.getByLabelText('Test Model download progress').getAttribute('value')).toBe('42');
  });

  it('uses the model-registry DB client for Turso refresh and toggles', async () => {
    const registryDb = { runtime: 'turso-registry' };
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    const toggleProvider = vi.fn().mockResolvedValue(undefined);
    const toggleModel = vi.fn().mockResolvedValue(undefined);
    useBrainstrikeDbClientMock.mockReturnValue(null);
    useModelRegistryDbClientMock.mockReturnValue(registryDb);
    setupStore();
    useModelRegistryStore.setState({ fetchRegistry, toggleModel, toggleProvider });

    render(<ModelRegistrySettingsSection />);

    await userEvent.click(screen.getByRole('button', { name: 'Refresh Registry' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Enable Local Provider' }));
    await userEvent.click(screen.getByRole('button', { name: /Expand Local Provider/i }));
    await userEvent.click(screen.getByRole('switch', { name: 'Enable Test Model' }));

    await waitFor(() => {
      expect(fetchRegistry).toHaveBeenCalledWith(registryDb);
      expect(toggleProvider).toHaveBeenCalledWith(registryDb, 'local', false, 'turso');
      expect(toggleModel).toHaveBeenCalledWith(registryDb, 'test-model', false, 'turso');
    });
  });
});
