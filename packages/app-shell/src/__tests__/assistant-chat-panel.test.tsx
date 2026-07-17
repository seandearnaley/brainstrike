import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantChatPanel } from '../assistant-chat-panel';

vi.mock('../hooks/use-assistant-availability-with-local', () => ({
  useAssistantAvailabilityWithLocal: vi.fn(),
}));

vi.mock('../assistant-ui-panel-wrapper-lazy', () => ({
  AssistantUiPanelWrapperLazy: () => <div>Assistant UI Panel</div>,
  preloadAssistantUiPanelWrapper: vi.fn(() => Promise.resolve()),
}));

// Import after mock to get the mocked version
import { useAssistantAvailabilityWithLocal } from '../hooks/use-assistant-availability-with-local';

const useAssistantAvailabilityWithLocalMock = vi.mocked(useAssistantAvailabilityWithLocal);

describe('AssistantChatPanel', () => {
  beforeEach(() => {
    useAssistantAvailabilityWithLocalMock.mockReset();
  });

  it('shows loading indicator while fetching status', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'loading' });

    render(<AssistantChatPanel />);

    expect(screen.getByTestId('assistant-panel-loading')).toHaveClass('h-full');
    expect(screen.getByTestId('assistant-panel-loading-tab-strip')).toHaveClass('h-12');
    expect(screen.getByText('Checking assistant availability…')).toHaveClass('sr-only');
  });

  it('renders disabled callout with optional reason', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      reason: 'no_provider',
      state: 'disabled',
    });

    render(<AssistantChatPanel />);

    expect(screen.getByText('Assistant disabled')).toBeInTheDocument();
    expect(screen.getByText(/Reason: no_provider/)).toBeInTheDocument();
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
});
