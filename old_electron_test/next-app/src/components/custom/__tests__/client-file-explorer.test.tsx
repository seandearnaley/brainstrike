import { render } from '@testing-library/react';
import ClientFileExplorer from '../client-file-explorer';

// Mock the dynamic import of FileExplorer
jest.mock('next/dynamic', () => () => {
  const DynamicComponent = () => <div data-testid="mock-file-explorer">File Explorer</div>;
  return DynamicComponent;
});

// Mock ErrorBoundary
jest.mock('../error-boundary', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-error-boundary">{children}</div>
  ),
}));

describe('ClientFileExplorer', () => {
  it('renders without crashing', () => {
    const { container } = render(<ClientFileExplorer />);
    expect(container).toBeInTheDocument();
  });

  it('renders with ErrorBoundary wrapper', () => {
    const { getByTestId } = render(<ClientFileExplorer />);
    expect(getByTestId('mock-error-boundary')).toBeInTheDocument();
  });

  it('renders FileExplorer component', () => {
    const { getByTestId } = render(<ClientFileExplorer />);
    expect(getByTestId('mock-file-explorer')).toBeInTheDocument();
  });
});
