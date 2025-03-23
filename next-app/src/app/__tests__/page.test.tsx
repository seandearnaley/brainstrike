import { render, screen } from '@testing-library/react';
import Home from '../page';

// Mock the ClientFileExplorer component since we want to unit test the page in isolation
jest.mock('@/components/custom/client-file-explorer', () => {
  return function MockClientFileExplorer() {
    return <div data-testid="mock-file-explorer">Mock File Explorer</div>;
  };
});

describe('Home Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the ClientFileExplorer component', () => {
    render(<Home />);
    expect(screen.getByTestId('mock-file-explorer')).toBeInTheDocument();
    expect(screen.getByText('Mock File Explorer')).toBeInTheDocument();
  });
});
