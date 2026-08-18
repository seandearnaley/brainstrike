import { __resetSecretsStoreForTests } from '@brainstrike/app-state/stores/secrets-store';
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

/**
 * The aws-authType slot's editor: bearer key + region (BST-1350) and the AWS
 * profile-chain mode (BST-1353). Split out of credential-inventory.test.tsx —
 * the shared harness above is duplicated deliberately so each file stays
 * independently readable and under the line cap.
 */
describe('CredentialInventory aws slot', () => {
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

  it('saves a PROFILE-CHAIN credential from the aws editor mode switch (BST-1353)', async () => {
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    const editor = screen.getByTestId('credential-editor-bedrock');
    // Bearer is the default mode — the zero-config starting point.
    expect(within(editor).queryByTestId('credential-key-input-bedrock')).not.toBeNull();

    fireEvent.click(within(editor).getByTestId('credential-mode-profile-bedrock'));
    // The bearer field is replaced by the profile field; the region stays.
    expect(within(editor).queryByTestId('credential-key-input-bedrock')).toBeNull();
    expect(within(editor).queryByTestId('credential-profile-hint-bedrock')).not.toBeNull();

    const save = within(editor).getByTestId('credential-save-bedrock') as HTMLButtonElement;
    // The region alone gates Save — the profile is OPTIONAL.
    expect(save.disabled).toBe(true);
    fireEvent.change(within(editor).getByTestId('credential-region-input-bedrock'), {
      target: { value: 'us-west-2' },
    });
    expect(save.disabled).toBe(false);

    fireEvent.change(within(editor).getByTestId('credential-profile-input-bedrock'), {
      target: { value: 'acme-dev' },
    });
    fireEvent.click(save);

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [provider, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    expect(provider).toBe('bedrock');
    if (!(credential.type === 'aws' && credential.mode === 'profile_chain')) {
      throw new Error('expected aws profile_chain credential');
    }
    expect(credential.profile).toBe('acme-dev');
    expect(credential.region).toBe('us-west-2');
    // A chain holds NO secret, so there is nothing to fingerprint.
    expect(credential.metadata).toBeUndefined();
  });

  it('saves a profile-chain credential with NO profile (the chain default)', async () => {
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    const editor = screen.getByTestId('credential-editor-bedrock');
    fireEvent.click(within(editor).getByTestId('credential-mode-profile-bedrock'));
    fireEvent.change(within(editor).getByTestId('credential-region-input-bedrock'), {
      target: { value: 'eu-central-1' },
    });
    fireEvent.click(within(editor).getByTestId('credential-save-bedrock'));

    await waitFor(() => {
      expect(getSecretsApi()?.saveCredential).toHaveBeenCalledTimes(1);
    });
    const saveCredentialMock = getSecretsApi()?.saveCredential as ReturnType<typeof vi.fn>;
    const [, credential] = saveCredentialMock.mock.calls[0] as [string, ProviderCredential];
    if (!(credential.type === 'aws' && credential.mode === 'profile_chain')) {
      throw new Error('expected aws profile_chain credential');
    }
    // Absent, not an empty string — the stored shape stays clean.
    expect(credential.profile).toBeUndefined();
  });

  it('SECURITY: gates the region format in PROFILE-CHAIN mode too (BST-1353)', async () => {
    // The chain builds the same `bedrock-runtime.<region>` hostname, so the
    // region check cannot be bearer-only.
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    const editor = screen.getByTestId('credential-editor-bedrock');
    fireEvent.click(within(editor).getByTestId('credential-mode-profile-bedrock'));
    fireEvent.change(within(editor).getByTestId('credential-region-input-bedrock'), {
      target: { value: 'evil.example.com/' },
    });

    expect(
      (within(editor).getByTestId('credential-save-bedrock') as HTMLButtonElement).disabled
    ).toBe(true);
    expect(within(editor).queryByTestId('credential-region-invalid-bedrock')).not.toBeNull();
    expect(getSecretsApi()?.saveCredential).not.toHaveBeenCalled();
  });

  it('SECURITY: disables Save and shows an inline hint for a malformed AWS region (BST-1350)', async () => {
    // The region is interpolated into the Bedrock request hostname, so a
    // value like `evil.example.com/` must never even reach the keychain —
    // the editor gates on the SHARED isValidAwsRegion and explains why.
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    const editor = screen.getByTestId('credential-editor-bedrock');
    const save = within(editor).getByTestId('credential-save-bedrock') as HTMLButtonElement;
    fireEvent.change(within(editor).getByTestId('credential-key-input-bedrock'), {
      target: { value: 'bedrock-bearer' },
    });

    for (const hostile of ['evil.example.com/', 'us-east-1/', 'US-EAST-1']) {
      fireEvent.change(within(editor).getByTestId('credential-region-input-bedrock'), {
        target: { value: hostile },
      });
      expect(save.disabled).toBe(true);
      expect(within(editor).getByTestId('credential-region-invalid-bedrock')).toBeTruthy();
    }

    fireEvent.change(within(editor).getByTestId('credential-region-input-bedrock'), {
      target: { value: 'us-east-1' },
    });
    expect(within(editor).queryByTestId('credential-region-invalid-bedrock')).toBeNull();
    expect(save.disabled).toBe(false);
    expect(getSecretsApi()?.saveCredential).not.toHaveBeenCalled();
  });

  it('maps a malformed_credential save rejection to actionable region guidance', async () => {
    // Store-side backstop for the same guard (isAwsCredential region format):
    // if the keychain write rejects a credential as malformed, the toast says
    // what a valid region looks like instead of "Unknown error".
    listProvidersMock.mockReturnValue([
      { authType: 'aws', displayName: 'Amazon Bedrock', id: 'bedrock' },
    ]);
    providerVendorEnvKeyMock.mockReturnValue('AWS_BEARER_TOKEN_BEDROCK');
    const base = createSecretsApi();
    setSecretsApi({
      ...base,
      saveCredential: vi.fn().mockResolvedValue({ error: 'malformed_credential', ok: false }),
    });

    render(<CredentialInventory />);
    await waitForReady();

    fireEvent.click(screen.getByTestId('credential-set-bedrock'));
    fireEvent.change(screen.getByTestId('credential-key-input-bedrock'), {
      target: { value: 'bedrock-bearer' },
    });
    fireEvent.change(screen.getByTestId('credential-region-input-bedrock'), {
      target: { value: 'us-east-1' },
    });
    fireEvent.click(screen.getByTestId('credential-save-bedrock'));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('us-east-1'),
          title: 'Failed to save key',
          variant: 'destructive',
        })
      );
    });
  });
});
