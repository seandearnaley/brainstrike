import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSecretsStoreForTests, useSecretsStore } from '../../../stores/secrets-store';
import { ApiKeysSettings } from '../api-keys-settings';

const { listProvidersMock, toastMock } = vi.hoisted(() => ({
  listProvidersMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@brainstrike/assistant-contract/provider-metadata', () => ({
  listProviders: listProvidersMock,
}));

vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    'data-testid': testId,
    variant: _variant,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
    variant?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode; className?: string }) => (
    <div>{children}</div>
  ),
  Input: ({
    id,
    onChange,
    placeholder,
    type,
    value,
    'data-testid': testId,
  }: {
    id?: string;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    value?: string;
    'data-testid'?: string;
  }) => (
    <input
      data-testid={testId}
      id={id}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  ),
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode; value: string }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    id,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    id?: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId} id={id}>
      {children}
    </div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ''}</span>,
  useToast: () => ({ toast: toastMock }),
}));

describe('ApiKeysSettings', () => {
  interface SecretsApi {
    clearAll: (confirmationToken?: string) => Promise<{ message?: string; success: boolean }>;
    deleteKey: (provider: string) => Promise<boolean>;
    getKey: (provider: string) => Promise<string | null>;
    list: () => Promise<string[]>;
    listStored: () => Promise<string[]>;
    saveKey: (
      provider: string,
      value: string
    ) => Promise<true | { error: 'encryption_unavailable' | 'unknown_error'; ok: false }>;
  }

  const setSecretsApi = (secrets: SecretsApi): void => {
    Object.defineProperty(window, 'secrets', {
      configurable: true,
      value: secrets,
      writable: true,
    });
  };

  const createSecretsApi = (): SecretsApi => ({
    clearAll: vi.fn().mockResolvedValue({ success: true }),
    deleteKey: vi.fn().mockResolvedValue(true),
    getKey: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue(['openai']),
    listStored: vi.fn().mockResolvedValue(['openai']),
    saveKey: vi.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __resetSecretsStoreForTests();
    listProvidersMock.mockReturnValue([
      { id: 'openai', displayName: 'OpenAI' },
      { id: 'google', displayName: 'Google' },
    ]);
    setSecretsApi(createSecretsApi());
  });

  afterEach(() => {
    // Clean up window.secrets to prevent test pollution
    // biome-ignore lint/performance/noDelete: test cleanup requires property removal
    delete (window as unknown as Record<string, unknown>)['secrets'];
  });

  it('loads stored providers using listStored when available', async () => {
    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('saved-llm-providers').textContent).toContain('openai');
    });

    expect(window.secrets?.listStored).toHaveBeenCalledTimes(1);
    expect(window.secrets?.list).not.toHaveBeenCalled();
  });

  it('falls back to list() when listStored fails', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue(['google']),
      listStored: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('saved-llm-providers').textContent).toContain('google');
    });

    expect(window.secrets?.listStored).toHaveBeenCalledTimes(1);
    expect(window.secrets?.list).toHaveBeenCalledTimes(1);
  });

  it('saves API keys and notifies dependent subscribers', async () => {
    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;

    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: '  sk-test  ' } });
    fireEvent.click(screen.getByTestId('save-llm-key'));

    await waitFor(() => {
      expect(window.secrets?.saveKey).toHaveBeenCalledWith('openai', 'sk-test');
    });
    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });

    expect((screen.getByTestId('llm-api-key') as HTMLInputElement).value).toBe('');
  });

  it('shows keychain encryption toast on save failure result', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      saveKey: vi.fn().mockResolvedValue({ ok: false, error: 'encryption_unavailable' }),
    });

    render(<ApiKeysSettings />);
    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByTestId('save-llm-key'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'OS keychain encryption is unavailable on this system.',
          title: 'Failed to save key',
          variant: 'destructive',
        })
      );
    });
  });

  it('deletes API keys and notifies dependent subscribers', async () => {
    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;

    fireEvent.click(screen.getByTestId('delete-llm-key'));

    await waitFor(() => {
      expect(window.secrets?.deleteKey).toHaveBeenCalledWith('openai');
    });
    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });
  });

  it('renders provider-specific hint for google provider', async () => {
    listProvidersMock.mockReturnValue([{ id: 'google', displayName: 'Google' }]);
    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-hint').textContent).toContain('Gemini API key');
    });
  });
});
