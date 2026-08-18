import {
  __resetSecretsStoreForTests,
  useSecretsStore,
} from '@brainstrike/app-state/stores/secrets-store';
import type { ProviderCredential, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialInventory } from '../credential-inventory/credential-inventory';

const { listProvidersMock, providerVendorEnvKeyMock, toastMock } = vi.hoisted(() => ({
  listProvidersMock: vi.fn(),
  providerVendorEnvKeyMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock('@brainstrike/assistant-contract/provider-metadata', () => ({
  listProviders: listProvidersMock,
  providerEnvKeys: (provider: string) =>
    provider === 'openai'
      ? ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY']
      : provider === 'google'
        ? ['BRAINSTRIKE_GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']
        : [],
  providerVendorEnvKey: providerVendorEnvKeyMock,
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
    size: _size,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    'data-testid'?: string;
    variant?: string;
    size?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
  CopyTextButton: ({ ariaLabel, text }: { ariaLabel: string; text: string | (() => string) }) => (
    <button aria-label={ariaLabel} data-testid="copy-docs-url" type="button">
      {typeof text === 'function' ? text() : text}
    </button>
  ),
  getProviderColor: () => 'hsl(0, 0%, 50%)',
  Input: ({
    autoFocus,
    id,
    onChange,
    onKeyDown,
    placeholder,
    type,
    value,
    'aria-label': ariaLabel,
    'data-testid': testId,
  }: {
    autoFocus?: boolean;
    id?: string;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    value?: string;
    'aria-label'?: string;
    'data-testid'?: string;
  }) => (
    <input
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      data-testid={testId}
      id={id}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  ),
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  ProviderIcon: ({ providerId }: { providerId: string }) => (
    <span data-testid={`provider-icon-${providerId}`} />
  ),
  Table: ({ children, ...rest }: { children: React.ReactNode }) => (
    <table {...rest}>{children}</table>
  ),
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children, colSpan }: { children?: React.ReactNode; colSpan?: number }) => (
    <td colSpan={colSpan}>{children}</td>
  ),
  TableHead: ({ children }: { children?: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <tr data-testid={testId}>{children}</tr>,
  TooltipIconButton: ({
    children,
    tooltip,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    tooltip: string;
    'data-testid'?: string;
  }) => (
    <button aria-label={tooltip} data-testid={testId} type="button">
      {children}
    </button>
  ),
  useToast: () => ({ toast: toastMock }),
}));

type ListedSource = ProviderKeySource<SupportedProvider | 'tavily'>;

interface SecretsApi {
  clearAll: (confirmationToken?: string) => Promise<{ message?: string; success: boolean }>;
  deleteKey: (provider: string) => Promise<boolean>;
  getKey: (provider: string) => Promise<string | null>;
  list: () => Promise<ListedSource[]>;
  listStored: () => Promise<string[]>;
  saveCredential?: (
    provider: string,
    credential: ProviderCredential
  ) => Promise<true | { error: string; ok: false }>;
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
  list: vi.fn().mockResolvedValue([]),
  listStored: vi.fn().mockResolvedValue([]),
  saveCredential: vi.fn().mockResolvedValue(true),
  saveKey: vi.fn().mockResolvedValue(true),
});

const OPENAI_DEFINITION = {
  authType: 'api_key',
  displayName: 'OpenAI',
  docsUrl: 'https://platform.openai.com/api-keys',
  id: 'openai',
  keyFormatHint: 'sk-proj-…',
  keyNotes: 'Create a key in the OpenAI dashboard.',
};
const GOOGLE_DEFINITION = { authType: 'api_key', displayName: 'Google', id: 'google' };
const OLLAMA_DEFINITION = {
  authType: 'none',
  displayName: 'Ollama (Local Runtime)',
  id: 'ollama',
};

const waitForReady = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryAllByTestId(/credential-status-skeleton-/)).toHaveLength(0);
  });
};

describe('CredentialInventory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSecretsStoreForTests();
    listProvidersMock.mockReturnValue([OPENAI_DEFINITION, GOOGLE_DEFINITION, OLLAMA_DEFINITION]);
    providerVendorEnvKeyMock.mockImplementation((provider: string) =>
      provider === 'openai'
        ? 'OPENAI_API_KEY'
        : provider === 'google'
          ? 'GOOGLE_GENERATIVE_AI_API_KEY'
          : undefined
    );
    setSecretsApi(createSecretsApi());
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup requires property removal
    delete (window as unknown as Record<string, unknown>)['secrets'];
  });

  it('renders one always-visible row per keyed slot plus Tavily, skipping keyless providers', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    expect(screen.getByTestId('credential-row-openai')).toBeDefined();
    expect(screen.getByTestId('credential-row-google')).toBeDefined();
    expect(screen.getByTestId('credential-row-tavily')).toBeDefined();
    expect(screen.queryByTestId('credential-row-ollama')).toBeNull();
    // The dropdown UI is gone.
    expect(screen.queryByTestId('llm-provider')).toBeNull();

    // Variable column teaches the exact canonical vendor env name.
    expect(screen.getByTestId('credential-env-var-openai').textContent).toBe('OPENAI_API_KEY');
    expect(screen.getByTestId('credential-env-var-google').textContent).toBe(
      'GOOGLE_GENERATIVE_AI_API_KEY'
    );
    expect(screen.getByTestId('credential-env-var-tavily').textContent).toBe('TAVILY_API_KEY');
  });

  it('renders exactly one row when filtered by the providers prop (BST-1358 seam)', async () => {
    render(<CredentialInventory providers={['openai']} />);
    await waitForReady();

    const rows = screen.getAllByTestId(/^credential-row-/);
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId('credential-row-openai')).toBeDefined();
    expect(screen.queryByTestId('credential-row-tavily')).toBeNull();
  });

  it('shows a skeleton status per slot while the listing loads (no layout jump)', () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn(() => new Promise<ListedSource[]>(() => undefined)),
    });

    render(<CredentialInventory />);

    expect(screen.getAllByTestId(/^credential-row-/)).toHaveLength(3);
    expect(screen.getAllByTestId(/^credential-status-skeleton-/)).toHaveLength(3);
    expect(screen.queryByTestId('credential-set-openai')).toBeNull();
  });

  it('keeps the load-error banner above the table and disables mutations', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockRejectedValue(new Error('Environment file is malformed.')),
    });

    render(<CredentialInventory />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'Environment file is malformed.'
      );
    });
    expect(screen.getAllByTestId(/^credential-row-/)).toHaveLength(3);
    expect((screen.getByTestId('credential-set-openai') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces malformed fingerprint metadata as a visible failure, never guessed', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        {
          metadata: { last4: '-123', savedAt: 'not-a-date' },
          provider: 'openai',
          source: 'stored',
        },
      ] as unknown as ListedSource[]),
    });

    render(<CredentialInventory />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'invalid credential status'
      );
    });
  });

  it('shows a Stored badge with the …last4 fingerprint and saved date', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        {
          metadata: { last4: '-123', savedAt: '2026-08-18T10:00:00.000Z' },
          provider: 'openai',
          source: 'stored',
        },
      ]),
    });

    render(<CredentialInventory />);
    await waitForReady();

    expect(screen.getByTestId('credential-status-openai').textContent).toBe('Stored');
    const fingerprint = screen.getByTestId('credential-fingerprint-openai').textContent ?? '';
    expect(fingerprint).toContain('…-123');
    expect(fingerprint).toContain(new Date('2026-08-18T10:00:00.000Z').toLocaleDateString());

    expect(screen.getByTestId('credential-replace-openai')).toBeDefined();
    expect(screen.getByTestId('credential-remove-openai')).toBeDefined();
    expect(screen.queryByTestId('credential-set-openai')).toBeNull();
  });

  it('shows a Stored badge without a fingerprint for legacy entries', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([{ provider: 'openai', source: 'stored' }]),
    });

    render(<CredentialInventory />);
    await waitForReady();

    expect(screen.getByTestId('credential-status-openai').textContent).toBe('Stored');
    expect(screen.queryByTestId('credential-fingerprint-openai')).toBeNull();
  });

  it('locks env rows read-only with the exact variable name and no editor affordances', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi
        .fn()
        .mockResolvedValue([{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }]),
    });

    render(<CredentialInventory />);
    await waitForReady();

    expect(screen.getByTestId('credential-status-openai').textContent).toBe('Env (OPENAI_API_KEY)');
    const lock = screen.getByTestId('credential-env-lock-openai');
    expect(lock.getAttribute('aria-label')).toContain('OPENAI_API_KEY is authoritative');
    expect(screen.queryByTestId('credential-set-openai')).toBeNull();
    expect(screen.queryByTestId('credential-replace-openai')).toBeNull();
    expect(screen.queryByTestId('credential-remove-openai')).toBeNull();
    expect(screen.queryByTestId('credential-fingerprint-openai')).toBeNull();
  });

  it('sorts stored first, then env, then not set, stable within groups', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { provider: 'google', source: 'stored' },
      ]),
    });

    render(<CredentialInventory />);
    await waitForReady();

    const ids = screen
      .getAllByTestId(/^credential-row-/)
      .map((row) => row.getAttribute('data-testid'));
    expect(ids).toEqual([
      'credential-row-google',
      'credential-row-openai',
      'credential-row-tavily',
    ]);
  });

  it('opens the inline editor from Set, autofocuses, and saves a fingerprinted api_key credential', async () => {
    render(<CredentialInventory />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    const editor = screen.getByTestId('credential-editor-google');
    const input = within(editor).getByTestId('credential-key-input-google');
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: '  sk-goog-abcd  ' } });
    fireEvent.click(within(editor).getByTestId('credential-save-google'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [provider, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    expect(provider).toBe('google');
    expect(credential.type).toBe('api_key');
    if (credential.type !== 'api_key') {
      throw new Error('expected api_key credential');
    }
    expect(credential.key).toBe('sk-goog-abcd');
    expect(credential.metadata?.['last4']).toBe('abcd');
    expect(Number.isNaN(Date.parse(credential.metadata?.['savedAt'] ?? ''))).toBe(false);
    expect(getSecretsApi()?.saveKey).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    });
  });

  it('saves on Enter and cancels on Escape without saving', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    const input = screen.getByTestId('credential-key-input-google');
    fireEvent.change(input, { target: { value: 'sk-goog-1234' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('credential-set-google'));
    const reopened = screen.getByTestId('credential-key-input-google');
    fireEvent.change(reopened, { target: { value: 'sk-discarded' } });
    fireEvent.keyDown(reopened, { key: 'Escape' });

    expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
  });

  it('renders registry hints and the copyable docs url inside the expanded editor', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-openai'));
    const editor = screen.getByTestId('credential-editor-openai');

    expect(within(editor).getByTestId('credential-editor-hint-openai').textContent).toBe(
      'Create a key in the OpenAI dashboard. Keys look like sk-proj-…'
    );
    expect(within(editor).getByTestId('credential-editor-docs-openai').textContent).toContain(
      'https://platform.openai.com/api-keys'
    );
    expect(within(editor).getByLabelText('Copy the OpenAI API key page URL').textContent).toContain(
      'https://platform.openai.com/api-keys'
    );
  });

  it('renders the aws editor variant (key + region) and saves a bearer credential', async () => {
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    const editor = screen.getByTestId('credential-editor-bedrock');
    const keyInput = within(editor).getByTestId('credential-key-input-bedrock');
    const regionInput = within(editor).getByTestId('credential-region-input-bedrock');
    const save = within(editor).getByTestId('credential-save-bedrock') as HTMLButtonElement;

    fireEvent.change(keyInput, { target: { value: 'bedrock-bearer' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(regionInput, { target: { value: 'us-east-1' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [provider, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    expect(provider).toBe('bedrock');
    if (!(credential.type === 'aws' && credential.mode === 'bearer')) {
      throw new Error('expected aws bearer credential');
    }
    expect(credential.bearerKey).toBe('bedrock-bearer');
    expect(credential.region).toBe('us-east-1');
    expect(credential.metadata?.['last4']).toBe('arer');
  });

  it('renders the deprecated-env rename warning from status data', async () => {
    render(
      <CredentialInventory
        deprecatedEnvVars={[
          { envVar: 'OPENAI_API_KEY_V2', provider: 'openai', replacement: 'OPENAI_API_KEY' },
        ]}
      />
    );
    await waitForReady();

    expect(screen.getByTestId('credential-deprecated-env-openai').textContent).toBe(
      'OPENAI_API_KEY_V2 is set but no longer read — rename it to OPENAI_API_KEY.'
    );
    expect(screen.queryByTestId('credential-deprecated-env-google')).toBeNull();
  });

  it('disables only the edited row while a save is in flight', async () => {
    let resolveSave: ((value: true) => void) | undefined;
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([{ provider: 'openai', source: 'stored' }]),
      saveCredential: vi.fn(
        () =>
          new Promise<true>((resolve) => {
            resolveSave = resolve;
          })
      ),
    });

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'sk-goog-busy' },
    });
    fireEvent.click(screen.getByTestId('credential-save-google'));

    expect((screen.getByTestId('credential-save-google') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('credential-cancel-google') as HTMLButtonElement).disabled).toBe(
      true
    );
    // The untouched stored row keeps its actions live.
    expect((screen.getByTestId('credential-replace-openai') as HTMLButtonElement).disabled).toBe(
      false
    );
    expect((screen.getByTestId('credential-remove-openai') as HTMLButtonElement).disabled).toBe(
      false
    );

    resolveSave?.(true);
    await waitFor(() => {
      expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    });
  });

  it('removes a stored key through the row Remove action', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([{ provider: 'openai', source: 'stored' }]),
    });

    render(<CredentialInventory />);
    const beforeVersion = useSecretsStore.getState().secretsVersion;
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-remove-openai'));

    await waitFor(() => {
      expect(getSecretsApi()?.deleteKey).toHaveBeenCalledWith('openai');
    });
    await waitFor(() => {
      expect(useSecretsStore.getState().secretsVersion).toBe(beforeVersion + 1);
    });
  });

  it('sets and saves the Tavily slot inline under the tavily secret id', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-tavily'));
    fireEvent.change(screen.getByTestId('credential-key-input-tavily'), {
      target: { value: 'tvly-abc' },
    });
    fireEvent.click(screen.getByTestId('credential-save-tavily'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [provider, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    expect(provider).toBe('tavily');
    if (credential.type !== 'api_key') {
      throw new Error('expected api_key credential');
    }
    expect(credential.key).toBe('tvly-abc');
  });

  it('lets an environment source from status override stored IPC state', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([{ provider: 'openai', source: 'stored' }]),
    });

    render(
      <CredentialInventory
        statusProviderKeySources={[
          { envVar: 'OPENAI_API_KEY', provider: 'openai' as SupportedProvider, source: 'env' },
        ]}
      />
    );
    await waitForReady();

    expect(screen.getByTestId('credential-status-openai').textContent).toBe('Env (OPENAI_API_KEY)');
    expect(screen.getByTestId('credential-env-lock-openai')).toBeDefined();
  });

  it('joins the status probe error into the visible banner', async () => {
    render(<CredentialInventory statusError="The user-data environment file is malformed." />);

    await waitFor(() => {
      expect(screen.getByTestId('provider-key-load-error').textContent).toContain(
        'The user-data environment file is malformed.'
      );
    });
  });

  it('fails visibly when the typed save capability is missing — no saveKey fallback', async () => {
    const base = createSecretsApi();
    const api: SecretsApi = { ...base };
    // biome-ignore lint/performance/noDelete: simulating an older preload without the typed method
    delete api.saveCredential;
    setSecretsApi(api);

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'sk-goog-nope' },
    });
    fireEvent.click(screen.getByTestId('credential-save-google'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Secure credential storage is unavailable.',
          title: 'Failed to save key',
          variant: 'destructive',
        })
      );
    });
    expect(getSecretsApi()?.saveKey).not.toHaveBeenCalled();
    // The editor stays open with the typed value — nothing was saved.
    expect((screen.getByTestId('credential-key-input-google') as HTMLInputElement).value).toBe(
      'sk-goog-nope'
    );
  });

  it('keeps the editor open and surfaces a toast when the store rejects the save', async () => {
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      saveCredential: vi.fn().mockResolvedValue({ error: 'encryption_unavailable', ok: false }),
    });

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'sk-goog-fail' },
    });
    fireEvent.click(screen.getByTestId('credential-save-google'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'OS keychain encryption is unavailable on this system.',
          title: 'Failed to save key',
          variant: 'destructive',
        })
      );
    });
    expect((screen.getByTestId('credential-key-input-google') as HTMLInputElement).value).toBe(
      'sk-goog-fail'
    );
  });
});
