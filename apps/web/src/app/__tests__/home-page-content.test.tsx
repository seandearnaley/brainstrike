import { render } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it, vi } from 'vitest';
import HomePageContent from '../home-page-content';

// Mock the ClientFileExplorer component
vi.mock('@brainstrike/file-explorer-app', () => ({
  __esModule: true,
  ClientFileExplorer: vi.fn(() => (
    <div data-testid="client-file-explorer">Mock ClientFileExplorer</div>
  )),
}));

describe('HomePageContent', () => {
  it('renders the ClientFileExplorer component', () => {
    const { getByTestId } = render(
      <HelmetProvider>
        <HomePageContent />
      </HelmetProvider>
    );

    // Check if the ClientFileExplorer is present
    expect(getByTestId('client-file-explorer')).toBeInTheDocument();
  });
});
