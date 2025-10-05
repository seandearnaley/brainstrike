import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantTab } from '../assistant-tab';
import { useAssistantAvailability } from '../hooks/use-assistant-availability';

vi.mock('../hooks/use-assistant-availability', () => ({
  useAssistantAvailability: vi.fn(),
}));

vi.mock('../assistant-ui-panel-wrapper', () => ({
  AssistantUiPanelWrapper: () => <div>Assistant UI Panel</div>,
}));

vi.mock('../mcp-banner', () => ({
  McpBanner: () => <div>MCP banner</div>,
}));

const useAssistantAvailabilityMock = vi.mocked(useAssistantAvailability);

describe('AssistantTab', () => {
  beforeEach(() => {
    useAssistantAvailabilityMock.mockReset();
  });

  it('shows loading indicator while fetching status', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'loading' });

    render(<AssistantTab />);

    expect(screen.getByText('Checking assistant availability…')).toBeInTheDocument();
  });

  it('renders disabled callout with optional reason', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'disabled', reason: 'no_provider' });

    render(<AssistantTab />);

    expect(screen.getByText('Assistant disabled')).toBeInTheDocument();
    expect(screen.getByText(/Reason: no_provider/)).toBeInTheDocument();
  });

  it('renders error callout when status fetch fails', () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'error', message: 'boom' });

    render(<AssistantTab />);

    expect(screen.getByText('Assistant unavailable')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows assistant UI when enabled', async () => {
    useAssistantAvailabilityMock.mockReturnValue({ state: 'enabled' });

    render(<AssistantTab />);

    expect(screen.getByText('MCP banner')).toBeInTheDocument();
    expect(await screen.findByText('Assistant UI Panel')).toBeInTheDocument();
  });
});
