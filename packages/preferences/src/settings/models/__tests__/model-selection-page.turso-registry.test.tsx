import { useToast } from '@brainstrike/ui';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '../../../stores/model-registry-store';
import { ModelSelectionPage } from '../model-selection-page';

const {
  useBrainstrikeDbClientMock,
  useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReportMock,
} = vi.hoisted(() => ({
  useBrainstrikeDbClientMock: vi.fn(),
  useModelRegistryDbClientMock: vi.fn(),
  useOptionalProfileBootstrapReportMock: vi.fn(),
}));

vi.mock('@brainstrike/db', () => ({
  DEFAULT_EMBEDDING_DIMENSION: 1536,
  useBrainstrikeDbClient: useBrainstrikeDbClientMock,
  useModelRegistryDbClient: useModelRegistryDbClientMock,
  useOptionalProfileBootstrapReport: useOptionalProfileBootstrapReportMock,
}));

vi.mock('../../../hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('../assistant-memory-settings-section', () => ({
  AssistantMemorySettingsSection: () => <div data-testid="assistant-memory-settings" />,
}));

vi.mock('../model-list', () => ({
  ModelList: ({ onToggle }: { onToggle: (modelId: string, enabled: boolean) => void }) => (
    <button data-testid="toggle-model" onClick={() => onToggle('test-model', false)} type="button">
      Toggle model
    </button>
  ),
}));

vi.mock('@brainstrike/ui', () => {
  interface MockComponentProps {
    children?: React.ReactNode;
    [key: string]: unknown;
  }

  return {
    useToast: vi.fn(),
    Button: ({ children, ...props }: MockComponentProps) => <button {...props}>{children}</button>,
    Input: (props: MockComponentProps) => <input {...props} />,
    Label: ({ children, ...props }: MockComponentProps) => <span {...props}>{children}</span>,
  };
});

describe('ModelSelectionPage Turso model-registry actions', () => {
  const mockToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetModelRegistryStoreForTests();
    useBrainstrikeDbClientMock.mockReturnValue(null);
    useModelRegistryDbClientMock.mockReturnValue({ runtime: 'turso-registry' });
    useOptionalProfileBootstrapReportMock.mockReturnValue({ runtime: { engine: 'turso' } });
    (useToast as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ toast: mockToast });
    useModelRegistryStore.setState({
      providers: [
        {
          icon: null,
          id: 'local',
          isEnabled: true,
          name: 'Local Provider',
          sortOrder: 0,
        },
      ],
      models: [
        {
          bestFor: null,
          capabilities: { type: 'embedding', streaming: false },
          description: 'A test model',
          icon: null,
          id: 'test-model',
          isEnabled: true,
          name: 'Test Model',
          parameters: null,
          providerId: 'local',
          sortOrder: 0,
          tagline: null,
        },
      ],
      hasLoaded: true,
      isLoading: false,
      error: null,
    });
  });

  it('uses the model-registry DB client for refresh and model toggles', async () => {
    const registryDb = { runtime: 'turso-registry' };
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    const toggleModel = vi.fn().mockResolvedValue(undefined);
    useBrainstrikeDbClientMock.mockReturnValue(null);
    useModelRegistryDbClientMock.mockReturnValue(registryDb);
    useModelRegistryStore.setState({ fetchRegistry, toggleModel });

    render(<ModelSelectionPage />);

    await userEvent.click(screen.getByTestId('model-registry-refresh'));
    await userEvent.click(screen.getByTestId('toggle-model'));

    await waitFor(() => {
      expect(fetchRegistry).toHaveBeenCalledWith(registryDb);
      expect(toggleModel).toHaveBeenCalledWith(registryDb, 'test-model', false, 'turso');
    });
  });
});
