import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantTab } from '../assistant-tab';

vi.mock('../hooks/use-assistant-availability-with-local', () => ({
  useAssistantAvailabilityWithLocal: vi.fn(),
}));

vi.mock('../assistant-ui-panel-wrapper', () => ({
  AssistantUiPanelWrapper: () => <div>Assistant UI Panel</div>,
}));

vi.mock('../mcp-banner', () => ({
  McpBanner: () => <div>MCP banner</div>,
}));

// Import after mock to get the mocked version
import { useAssistantAvailabilityWithLocal } from '../hooks/use-assistant-availability-with-local';

const useAssistantAvailabilityWithLocalMock = vi.mocked(useAssistantAvailabilityWithLocal);

describe('AssistantTab', () => {
  beforeEach(() => {
    useAssistantAvailabilityWithLocalMock.mockReset();
  });

  it('shows loading indicator while fetching status', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'loading' });

    render(<AssistantTab />);

    expect(screen.getByText('Checking assistant availability…')).toBeInTheDocument();
  });

  it('renders disabled callout with optional reason', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({
      state: 'disabled',
      reason: 'no_provider',
    });

    render(<AssistantTab />);

    expect(screen.getByText('Assistant disabled')).toBeInTheDocument();
    expect(screen.getByText(/Reason: no_provider/)).toBeInTheDocument();
  });

  it('renders error callout when status fetch fails', () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'error', message: 'boom' });

    render(<AssistantTab />);

    expect(screen.getByText('Assistant unavailable')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows assistant UI when enabled', async () => {
    useAssistantAvailabilityWithLocalMock.mockReturnValue({ state: 'enabled' });

    render(<AssistantTab />);

    expect(screen.getByText('MCP banner')).toBeInTheDocument();
    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
  });
});
