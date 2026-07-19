import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantChatPanel } from '../assistant-chat-panel';

const { assistantUiPanelWrapperLazyMock } = vi.hoisted(() => ({
  assistantUiPanelWrapperLazyMock: vi.fn(() => <div>Assistant UI Panel</div>),
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
      screen.getByText(
        'Configure an AI provider in Settings → LLM Provider Keys to enable the assistant.'
      )
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
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'enabled' });

    render(<AssistantChatPanel />);

    expect(screen.queryByRole('heading', { name: 'Assistant' })).not.toBeInTheDocument();
    expect(
      screen.queryByText('Chat with the Brainstrike assistant while working anywhere in the app.')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('MCP banner')).not.toBeInTheDocument();
    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
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
        initialProviders: ['openai'],
      }),
      undefined
    );
  });
});
