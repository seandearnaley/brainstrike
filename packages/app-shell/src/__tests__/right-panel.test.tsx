import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { RightPanel } from '../right-panel';

describe('RightPanel', () => {
  test('renders with all tabs', () => {
    render(<RightPanel />);

    // Check that all tab triggers are present
    expect(screen.getByRole('tab', { name: /props/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /layers/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /config/i })).toBeInTheDocument();
  });

  test('shows properties tab content by default', () => {
    render(<RightPanel />);

    // Properties tab should be active by default
    expect(screen.getByText('Properties')).toBeInTheDocument();
    expect(screen.getByText('Element properties and attributes')).toBeInTheDocument();
    expect(screen.getByText('Basic Properties')).toBeInTheDocument();
  });

  test('allows switching between tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Click on the layers tab
    await user.click(screen.getByRole('tab', { name: /layers/i }));

    // Should show layers content
    expect(screen.getByText('Layer hierarchy and organization')).toBeInTheDocument();
    expect(screen.getByText('Layer Structure')).toBeInTheDocument();

    // Click on the search tab
    await user.click(screen.getByRole('tab', { name: /search/i }));

    // Should show search content
    expect(screen.getByText('Search and replace functionality')).toBeInTheDocument();
    expect(screen.getByText('Search Options')).toBeInTheDocument();

    // Click on the config tab
    await user.click(screen.getByRole('tab', { name: /config/i }));

    // Should show config content
    expect(screen.getByText('Application settings and preferences')).toBeInTheDocument();
    expect(screen.getByText('General Settings')).toBeInTheDocument();
  });

  test('has proper tab structure with icons', () => {
    render(<RightPanel />);

    // Check that tabs have icons (we can't easily test the actual icons, but we can check the structure)
    const tabList = screen.getByRole('tablist');
    expect(tabList).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);

    // Each tab should have text content
    expect(tabs[0]).toHaveTextContent('Props');
    expect(tabs[1]).toHaveTextContent('Layers');
    expect(tabs[2]).toHaveTextContent('Search');
    expect(tabs[3]).toHaveTextContent('Config');
  });

  test('maintains content state when switching tabs', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Switch to layers tab
    await user.click(screen.getByRole('tab', { name: /layers/i }));
    expect(screen.getByText('Layer Structure')).toBeInTheDocument();

    // Switch back to properties tab
    await user.click(screen.getByRole('tab', { name: /props/i }));
    expect(screen.getByText('Basic Properties')).toBeInTheDocument();

    // Switch to layers again - content should still be there
    await user.click(screen.getByRole('tab', { name: /layers/i }));
    expect(screen.getByText('Layer Structure')).toBeInTheDocument();
  });
});
