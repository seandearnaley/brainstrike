import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysSettings } from '../api-keys-settings';

const { listProvidersMock, toastMock } = vi.hoisted(() => ({
  listProvidersMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@brainstrike/assistant-contract/provider-metadata', () => ({
  listProviders: listProvidersMock,
  providerEnvKeys: (provider: string) =>
    provider === 'openai'
      ? ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY']
      : provider === 'google'
        ? ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY']
        : [],
}));

vi.mock('@brainstrike/ui', () => ({
  Badge: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <span data-testid={testId}>{children}</span>,
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
    list: () => Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>;
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

  const getSecretsApi = (): SecretsApi | undefined =>
    (window as unknown as { secrets?: SecretsApi }).secrets;

  const createSecretsApi = (): SecretsApi => ({
    clearAll: vi.fn().mockResolvedValue({ success: true }),
    deleteKey: vi.fn().mockResolvedValue(true),
    getKey: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([{ provider: 'openai', source: 'stored' }]),
    listStored: vi.fn().mockResolvedValue(['openai']),
    saveKey: vi.fn().mockResolvedValue(true),
  });

  const waitForCredentialSources = async (): Promise<void> => {
    await waitFor(() => {
      expect(screen.getByTestId('provider-key-status').textContent).not.toContain(
        'Checking credential source'
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetSecretsStoreForTests();
    listProvidersMock.mockReturnValue([
      { displayName: 'OpenAI', id: 'openai' },
      { displayName: 'Google', id: 'google' },
    ]);
    setSecretsApi(createSecretsApi());
  });

  afterEach(() => {
    // Clean up window.secrets to prevent test pollution
    // biome-ignore lint/performance/noDelete: test cleanup requires property removal
    delete (window as unknown as Record<string, unknown>)['secrets'];
  });

  it('loads provider key sources from the metadata list', async () => {
    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-status').textContent).toContain('Saved in keychain');
    });

    expect(getSecretsApi()?.list).toHaveBeenCalledTimes(1);
    expect(getSecretsApi()?.listStored).not.toHaveBeenCalled();
  });

  it('surfaces provider key source load failures without falling back', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockRejectedValue(new Error('Environment file is malformed.')),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'Environment file is malformed.'
      );
    });

    expect(getSecretsApi()?.list).toHaveBeenCalledTimes(1);
    expect(getSecretsApi()?.listStored).not.toHaveBeenCalled();
    expect(screen.getByTestId('provider-key-status').textContent).toContain(
      'Credential status unavailable'
    );
    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: 'sk-inert' } });
    expect((screen.getByTestId('save-llm-key') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps credential mutations disabled until source inspection completes', async () => {
    let resolveList:
      | ((sources: ProviderKeySource<SupportedProvider | 'tavily'>[]) => void)
      | undefined;
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn(
        () =>
          new Promise<ProviderKeySource<SupportedProvider | 'tavily'>[]>((resolve) => {
            resolveList = resolve;
          })
      ),
    });

    render(<ApiKeysSettings />);
    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: 'sk-wait' } });

    expect(screen.getByTestId('provider-key-status').textContent).toContain(
      'Checking credential source'
    );
    expect((screen.getByTestId('save-llm-key') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('delete-llm-key') as HTMLButtonElement).disabled).toBe(true);

    resolveList?.([]);
    await waitFor(() => {
      expect(screen.getByTestId('provider-key-status').textContent).toContain('Not configured');
    });
    expect((screen.getByTestId('save-llm-key') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('delete-llm-key') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('delete-tavily-key') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces malformed provider key source payloads', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi
        .fn()
        .mockResolvedValue([
          { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'stored' },
        ] as unknown as ProviderKeySource<SupportedProvider | 'tavily'>[]),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'invalid credential status'
      );
    });
  });

  it('rejects environment variables that do not belong to the reported provider', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        {
          envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
          provider: 'openai',
          source: 'env',
        },
      ]),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'invalid credential status'
      );
    });
  });

  it('saves API keys and notifies dependent subscribers', async () => {
    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();

    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: '  sk-test  ' } });
    fireEvent.click(screen.getByTestId('save-llm-key'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveKey).toHaveBeenCalledWith('openai', 'sk-test');
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
      saveKey: vi.fn().mockResolvedValue({ error: 'encryption_unavailable', ok: false }),
    });

    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();
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
    expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion);
    expect((screen.getByTestId('llm-api-key') as HTMLInputElement).value).toBe('sk-test');
  });

  it('surfaces a thrown save and does not report success', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      saveKey: vi.fn().mockRejectedValue(new Error('keychain locked')),
    });

    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();
    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByTestId('save-llm-key'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Failed to save key',
          variant: 'destructive',
        })
      );
    });
    expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion);
    expect((screen.getByTestId('llm-api-key') as HTMLInputElement).value).toBe('sk-test');
  });

  it('deletes API keys and notifies dependent subscribers', async () => {
    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();

    fireEvent.click(screen.getByTestId('delete-llm-key'));

    await waitFor(() => {
      expect(getSecretsApi()?.deleteKey).toHaveBeenCalledWith('openai');
    });
    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });
  });

  it('surfaces a thrown delete and does not notify dependent subscribers', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      deleteKey: vi.fn().mockRejectedValue(new Error('keychain locked')),
    });

    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();
    fireEvent.click(screen.getByTestId('delete-llm-key'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Failed to delete key',
          variant: 'destructive',
        })
      );
    });
    expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion);
  });

  it('treats a raced already-absent provider key as successful convergence', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      deleteKey: vi.fn().mockResolvedValue(false),
    });

    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();
    fireEvent.click(screen.getByTestId('delete-llm-key'));

    await waitFor(() => {
      expect(getSecretsApi()?.list).toHaveBeenCalledTimes(2);
    });
    expect(toastMock).not.toHaveBeenCalled();
    expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
  });

  it('renders provider-specific hint for google provider', async () => {
    listProvidersMock.mockReturnValue([{ displayName: 'Google', id: 'google' }]);
    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-hint').textContent).toContain('Gemini API key');
    });
  });

  it('renders an environment badge and prevents an inert provider save', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        {
          envVar: 'BRAINSTRIKE_OPENAI_API_KEY',
          provider: 'openai',
          source: 'env',
        },
      ]),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-status').textContent).toContain(
        'Environment key (BRAINSTRIKE_OPENAI_API_KEY)'
      );
    });
    expect(screen.getByTestId('provider-env-key-warning').textContent).toContain(
      'BRAINSTRIKE_OPENAI_API_KEY'
    );

    fireEvent.change(screen.getByTestId('llm-api-key'), { target: { value: 'inert-key' } });
    expect((screen.getByTestId('save-llm-key') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('save-llm-key'));
    expect(getSecretsApi()?.saveKey).not.toHaveBeenCalled();
  });

  it('lets an environment source from status override stored IPC metadata', async () => {
    render(
      <ApiKeysSettings
        statusProviderKeySources={[
          {
            envVar: 'OPENAI_API_KEY',
            provider: 'openai',
            source: 'env',
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-status').textContent).toContain(
        'Environment key (OPENAI_API_KEY)'
      );
    });
  });

  it('surfaces the status probe error in the API keys card', async () => {
    render(<ApiKeysSettings statusError="The user-data environment file is malformed." />);

    expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
      'The user-data environment file is malformed.'
    );
  });

  it('saves the Tavily web-search key under the tavily secret id', async () => {
    render(<ApiKeysSettings />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForCredentialSources();

    fireEvent.change(screen.getByTestId('tavily-api-key'), { target: { value: '  tvly-abc  ' } });
    fireEvent.click(screen.getByTestId('save-tavily-key'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveKey).toHaveBeenCalledWith('tavily', 'tvly-abc');
    });
    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });
    expect((screen.getByTestId('tavily-api-key') as HTMLInputElement).value).toBe('');
  });

  it('deletes the Tavily key under the tavily secret id', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        { provider: 'openai', source: 'stored' },
        { provider: 'tavily', source: 'stored' },
      ]),
    });

    render(<ApiKeysSettings />);
    await waitForCredentialSources();

    fireEvent.click(screen.getByTestId('delete-tavily-key'));

    await waitFor(() => {
      expect(getSecretsApi()?.deleteKey).toHaveBeenCalledWith('tavily');
    });
  });

  it('reflects a configured Tavily key in its status line', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        { provider: 'openai', source: 'stored' },
        { provider: 'tavily', source: 'stored' },
      ]),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('tavily-key-status').textContent).toContain('Saved in keychain');
    });
  });

  it('gives Tavily the same environment-authority warning and disabled save', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        {
          envVar: 'BRAINSTRIKE_TAVILY_API_KEY',
          provider: 'tavily',
          source: 'env',
        },
      ]),
    });

    render(<ApiKeysSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('tavily-key-status').textContent).toContain(
        'Environment key (BRAINSTRIKE_TAVILY_API_KEY)'
      );
    });
    expect(screen.getByTestId('tavily-env-key-warning').textContent).toContain(
      'BRAINSTRIKE_TAVILY_API_KEY'
    );

    fireEvent.change(screen.getByTestId('tavily-api-key'), { target: { value: 'inert-key' } });
    expect((screen.getByTestId('save-tavily-key') as HTMLButtonElement).disabled).toBe(true);
  });
});
