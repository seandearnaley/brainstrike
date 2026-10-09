import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantChatPanel } from '../assistant-chat-panel';

const {
  assistantProviderModelDefaultsMock,
  assistantProviderSourceProviderMock,
  assistantUiPanelWrapperLazyMock,
} = vi.hoisted(() => ({
  assistantProviderModelDefaultsMock: vi.fn((_props: Record<string, unknown>) => (
    <div data-testid="provider-model-defaults-owner" />
  )),
  assistantProviderSourceProviderMock: vi.fn(),
  assistantUiPanelWrapperLazyMock: vi.fn((_props: Record<string, unknown>) => (
    <div>Assistant UI Panel</div>
  )),
}));

vi.mock('../hooks/assistant-provider-source', () => ({
  AssistantProviderSourceProvider: ({
    children,
    source,
  }: {
    children: ReactNode;
    source: unknown;
  }) => {
    assistantProviderSourceProviderMock(source);
    return <div data-testid="provider-source">{children}</div>;
  },
}));

vi.mock('../assistant-provider-model-defaults', () => ({
  AssistantProviderModelDefaults: assistantProviderModelDefaultsMock,
}));

vi.mock('../hooks/use-assistant-availability-with-local', () => ({
  useAssistantAvailabilityWithLocal: vi.fn(),
}));

vi.mock('../assistant-ui-panel-wrapper-lazy', () => ({
  AssistantUiPanelWrapperLazy: assistantUiPanelWrapperLazyMock,
  preloadAssistantUiPanelWrapper: vi.fn(() => Promise.resolve()),
}));

// Import after mock to get the mocked version
import { useAssistantAvailabilityWithLocal } from '../hooks/use-assistant-availability-with-local';

const useAssistantAvailabilityWithLocalMock = vi.mocked(useAssistantAvailabilityWithLocal);

describe('AssistantChatPanel', () => {
  beforeEach(() => {
    assistantProviderModelDefaultsMock.mockClear();
    assistantProviderSourceProviderMock.mockClear();
    assistantUiPanelWrapperLazyMock.mockClear();
    useAssistantAvailabilityWithLocalMock.mockReset();
  });

  it('shows loading indicator while fetching status', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'loading' });

    render(<AssistantChatPanel />);

    expect(screen.getByTestId('assistant-panel-loading')).toHaveClass('h-full');
    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-9');
    expect(screen.getByText('Checking assistant availability…')).toHaveClass('sr-only');
  });

  it('directs a missing API key to the current provider-key settings', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      reason: 'missing_api_key',
      state: 'disabled',
    });

    render(<AssistantChatPanel />);

    expect(screen.getByText('Assistant disabled')).toBeInTheDocument();
    expect(
      screen.getByText('Configure an AI provider in Settings → Providers to enable the assistant.')
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: missing_api_key')).toBeInTheDocument();
  });

  it('explains the protected Preview or public auth and quota requirement', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      reason: 'production_auth_required',
      state: 'disabled',
    });

    render(<AssistantChatPanel />);

    expect(
      screen.getByText(
        'Use a protected Preview deployment, or add application authentication with distributed quota and cost controls before enabling the assistant publicly.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: production_auth_required')).toBeInTheDocument();
  });

  it('explains how to repair an invalid Hosted Web body-limit configuration', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      reason: 'invalid_request_body_limit_config',
      state: 'disabled',
    });

    render(<AssistantChatPanel />);

    expect(
      screen.getByText(
        'Set BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES to a positive safe integer no greater than 4194304, then restart or redeploy the server.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: invalid_request_body_limit_config')).toBeInTheDocument();
  });

  it('keeps an unknown disabled reason visible without guessing at remediation', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      reason: 'future_server_reason',
      state: 'disabled',
    });

    render(<AssistantChatPanel />);

    expect(
      screen.getByText('The assistant status endpoint reported that the assistant is disabled.')
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: future_server_reason')).toBeInTheDocument();
  });

  it('renders error callout when status fetch fails', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ message: 'boom', state: 'error' });

    render(<AssistantChatPanel />);

    expect(screen.getByText('Assistant unavailable')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows assistant UI when enabled', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      providers: ['openai', 'local'],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(screen.queryByRole('heading', { name: 'Assistant' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Chat with the Brainstrike assistant while working anywhere in the app.')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('MCP banner')).not.toBeInTheDocument();
    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    expect(assistantProviderSourceProviderMock).toHaveBeenCalledWith({
      kind: 'discovery',
      seeds: ['openai', 'local'],
    });
  });

  it('passes provider read failures to the enabled assistant UI', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      providerErrors: [
        {
          code: 'decrypt_failed',
          error: 'api_key_unreadable',
          message: 'Stored OpenRouter key is unreadable. Re-enter it to repair access.',
          provider: 'openrouter',
        },
      ],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    expect(assistantUiPanelWrapperLazyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerReadErrors: {
          openrouter: 'Stored OpenRouter key is unreadable. Re-enter it to repair access.',
        },
      }),
      undefined
    );
  });

  it('mounts one model-defaults owner inside the provider source, for every thread kind', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      providerErrors: [
        {
          code: 'decrypt_failed',
          error: 'api_key_unreadable',
          message: 'Stored OpenRouter key is unreadable. Re-enter it to repair access.',
          provider: 'openrouter',
        },
      ],
      providers: ['openrouter'],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    const owners = screen.getAllByTestId('provider-model-defaults-owner');
    expect(owners).toHaveLength(1);
    expect(screen.getByTestId('provider-source')).toContainElement(owners[0] ?? null);
    expect(assistantProviderModelDefaultsMock).toHaveBeenLastCalledWith(
      {
        providerReadErrors: {
          openrouter: 'Stored OpenRouter key is unreadable. Re-enter it to repair access.',
        },
      },
      undefined
    );
  });

  it('passes validated provider key sources to assistant memory gating', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      providerKeySources: [
        { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
        { provider: 'anthropic', source: 'stored' },
      ],
      providers: ['openai', 'anthropic'],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    expect(assistantUiPanelWrapperLazyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKeySources: [
          { envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' },
          { provider: 'anthropic', source: 'stored' },
        ],
      }),
      undefined
    );
  });

  it('seeds the model picker with the provider advertised by Hosted Web', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    expect(assistantUiPanelWrapperLazyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fixedProviderModels: { openai: ['gpt-5.6-terra'] },
      }),
      undefined
    );
    expect(assistantProviderSourceProviderMock).toHaveBeenCalledWith({
      kind: 'authoritative',
      providers: ['openai'],
    });
  });

  it('fixes every Hosted Web provider to its registry default model', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providers: ['openai', 'anthropic', 'google', 'openrouter'],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
    expect(assistantUiPanelWrapperLazyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fixedProviderModels: {
          anthropic: ['claude-sonnet-5'],
          google: ['gemini-3.5-flash'],
          openai: ['gpt-5.6-terra'],
          openrouter: ['openai/gpt-5.6-terra'],
        },
      }),
      undefined
    );
    expect(assistantProviderSourceProviderMock).toHaveBeenCalledWith({
      kind: 'authoritative',
      providers: ['openai', 'anthropic', 'google', 'openrouter'],
    });
  });

  it('keeps fixed provider models referentially stable across equivalent renders', () => {
    const status = {
      model: 'gpt-5.6-terra',
      provider: 'openai' as const,
      providers: ['openai', 'anthropic'] as const,
      state: 'enabled' as const,
    };
    useAssistantAvailabilityWithLocalMock.mockReturnValue(status);

    const { rerender } = render(<AssistantChatPanel />);
    const firstModels =
      assistantUiPanelWrapperLazyMock.mock.calls.at(-1)?.[0]['fixedProviderModels'];

    rerender(<AssistantChatPanel />);

    expect(assistantUiPanelWrapperLazyMock.mock.calls.at(-1)?.[0]['fixedProviderModels']).toBe(
      firstModels
    );
  });

  it('surfaces an advertised provider without a registry default instead of crashing render', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      model: 'gpt-5.6-terra',
      provider: 'openai',
      providers: ['openai', 'cohere'],
      state: 'enabled',
    });

    render(<AssistantChatPanel />);

    expect(screen.getByText('Assistant unavailable')).toBeInTheDocument();
    expect(
      screen.getByText('Assistant status provider cohere has no registry default model')
    ).toBeInTheDocument();
    expect(assistantUiPanelWrapperLazyMock).not.toHaveBeenCalled();
  });
});
