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
  // BST-1353: derived from whatever definitions the test mounted, so an aws
  // slot reports authType 'aws' without a second hand-maintained table.
  providerAuthType: (provider: string) =>
    (listProvidersMock() as { authType: string; id: string }[]).find(
      (definition) => definition.id === provider
    )?.authType ?? 'api_key',
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
    ref,
    'data-testid': testId,
    variant: _variant,
    size: _size,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    ref?: React.Ref<HTMLButtonElement>;
    'data-testid'?: string;
    variant?: string;
    size?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} ref={ref} type="button">
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
    className,
    'data-highlighted': highlighted,
    'data-testid': testId,
    ref,
  }: {
    children: React.ReactNode;
    className?: string;
    'data-highlighted'?: string;
    'data-testid'?: string;
    ref?: React.Ref<HTMLTableRowElement>;
  }) => (
    <tr className={className} data-highlighted={highlighted} data-testid={testId} ref={ref}>
      {children}
    </tr>
  ),
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

  it('renders normally when the listing mentions a stored keyless provider (no row, no blanking)', async () => {
    // The bridge lists ANY stored provider id it knows (e.g. a keyless local
    // runtime like ollama). The table shows no row for it — but the entry must
    // parse, never blank the whole table (BST-1362 review blocker).
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      list: vi.fn().mockResolvedValue([
        { provider: 'ollama', source: 'stored' },
        { provider: 'openai', source: 'stored' },
      ] as ListedSource[]),
    });

    render(<CredentialInventory />);
    await waitForReady();

    expect(screen.queryByTestId('provider-key-load-error')).toBeNull();
    expect(screen.queryByTestId('credential-row-ollama')).toBeNull();
    expect(screen.getByTestId('credential-status-openai').textContent).toBe('Stored');
    expect(screen.getByTestId('credential-status-google').textContent).toBe('Not set');
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

  it('saves a short secret (< 8 chars) without any fingerprint metadata', async () => {
    // …last4 of a very short secret would reveal half or more of the key
    // material, so short saves carry no metadata: the row will show a plain
    // Stored badge with no hint.
    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'shortky' },
    });
    fireEvent.click(screen.getByTestId('credential-save-google'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    if (credential.type !== 'api_key') {
      throw new Error('expected api_key credential');
    }
    expect(credential.key).toBe('shortky');
    expect('metadata' in credential).toBe(false);
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

  it('restores focus to the row Set/Replace trigger when the editor closes', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    // Escape path.
    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.keyDown(screen.getByTestId('credential-key-input-google'), { key: 'Escape' });
    expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('credential-set-google'));
    });

    // Cancel-button path.
    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.click(screen.getByTestId('credential-cancel-google'));
    expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('credential-set-google'));
    });
  });

  it('scopes Escape handling to the editor — outside presses are neither swallowed nor cancel it', async () => {
    render(<CredentialInventory />);
    await waitForReady();

    // Simulated Radix DismissableLayer: a document-level CAPTURE listener
    // that dismisses the dialog unless the event was already claimed. The
    // editor's handler must run first for presses INSIDE the editor (so the
    // settings dialog stays open) and must not touch any other press.
    const dismissals: KeyboardEvent[] = [];
    const dismissLikeRadix = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        dismissals.push(event);
      }
    };
    document.addEventListener('keydown', dismissLikeRadix, { capture: true });
    try {
      fireEvent.click(screen.getByTestId('credential-set-google'));
      fireEvent.keyDown(screen.getByTestId('credential-key-input-google'), { key: 'Escape' });
      // Inside press: editor cancelled, dialog-dismissal never saw the event.
      expect(screen.queryByTestId('credential-editor-google')).toBeNull();
      expect(dismissals).toHaveLength(0);

      // Outside press while an editor is open: the editor stays, and the
      // event reaches dialog-dismissal untouched (no global swallowing).
      fireEvent.click(screen.getByTestId('credential-set-google'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.getByTestId('credential-editor-google')).toBeDefined();
      expect(dismissals).toHaveLength(1);
    } finally {
      document.removeEventListener('keydown', dismissLikeRadix, { capture: true });
    }
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

  it('keeps rows consistent across concurrent remove(openai) + save(google) mutations', async () => {
    // Busy state is keyed by slot id: one row's finishing mutation must clear
    // only its OWN busy flag, never another row's in-flight state or draft.
    let resolveDelete: ((value: boolean) => void) | undefined;
    let resolveSave: ((value: true) => void) | undefined;
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      deleteKey: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveDelete = resolve;
          })
      ),
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

    // Start the remove on openai, then a save on google while it is in flight.
    fireEvent.click(screen.getByTestId('credential-remove-openai'));
    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'sk-goog-concurrent' },
    });
    fireEvent.click(screen.getByTestId('credential-save-google'));

    expect((screen.getByTestId('credential-save-google') as HTMLButtonElement).disabled).toBe(true);

    // openai's remove finishes first; google's mutation must stay busy and
    // its editor draft must survive.
    resolveDelete?.(true);
    await waitFor(() => {
      expect(getSecretsApi()?.deleteKey).toHaveBeenCalledWith('openai');
    });
    await waitForReady();
    expect((screen.getByTestId('credential-save-google') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('credential-cancel-google') as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((screen.getByTestId('credential-key-input-google') as HTMLInputElement).value).toBe(
      'sk-goog-concurrent'
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

  it('no-ops Save and closes the editor when the slot source is env (authoritative)', async () => {
    // Symmetric with handleRemove's stored-guard: an env slot is read-only,
    // so a Save racing an env source appearing must not write to the keychain.
    const { rerender } = render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-openai'));
    fireEvent.change(screen.getByTestId('credential-key-input-openai'), {
      target: { value: 'sk-open-racy' },
    });

    // The status probe now reports the slot as env-configured.
    rerender(
      <CredentialInventory
        statusProviderKeySources={[
          { envVar: 'OPENAI_API_KEY', provider: 'openai' as SupportedProvider, source: 'env' },
        ]}
      />
    );

    fireEvent.click(screen.getByTestId('credential-save-openai'));

    await waitFor(() => {
      expect(screen.queryByTestId('credential-editor-openai')).toBeNull();
    });
    expect(getSecretsApi()?.saveCredential).not.toHaveBeenCalled();
  });

  it('clears an open editor whose slot became env when the listing reloads', async () => {
    const base = createSecretsApi();
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ provider: 'openai', source: 'stored' }] as ListedSource[])
      .mockResolvedValue([
        { envVar: 'GOOGLE_GENERATIVE_AI_API_KEY', provider: 'google', source: 'env' },
      ] as ListedSource[]);
    setSecretsApi({ ...base, list });

    render(<CredentialInventory />);
    await waitForReady();

    // Open google's editor while it is Not set, then remove openai — the
    // refresh reports google as env-configured, which must close the editor.
    fireEvent.click(screen.getByTestId('credential-set-google'));
    fireEvent.change(screen.getByTestId('credential-key-input-google'), {
      target: { value: 'sk-goog-stale' },
    });
    fireEvent.click(screen.getByTestId('credential-remove-openai'));

    await waitFor(() => {
      expect(screen.queryByTestId('credential-editor-google')).toBeNull();
    });
    expect(screen.getByTestId('credential-status-google').textContent).toBe(
      'Env (GOOGLE_GENERATIVE_AI_API_KEY)'
    );
    expect(getSecretsApi()?.saveCredential).not.toHaveBeenCalled();
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
