import { render, screen } from '@testing-library/react';
import { Database } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { StatusBarItem } from '../status-bar';

describe('StatusBarItem', () => {
  it('renders label text', () => {
    render(<StatusBarItem label="Test Label" testId="test-item" />);
    expect(screen.getByText('Test Label')).toBeInTheDocument();
  });

  it('renders value text', () => {
    render(<StatusBarItem testId="test-item" value="Test Value" />);
    expect(screen.getByText('Test Value')).toBeInTheDocument();
  });

  it('renders both label and value', () => {
    render(<StatusBarItem label="Label:" testId="test-item" value="Value" />);
    expect(screen.getByText('Label:')).toBeInTheDocument();
    expect(screen.getByText('Value')).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(<StatusBarItem icon={Database} label="DB" testId="test-item" />);
    // The icon should be rendered as an SVG
    const item = screen.getByTestId('test-item');
    expect(item.querySelector('svg')).toBeInTheDocument();
  });

  it('applies connected status styling', () => {
    render(<StatusBarItem label="Connected" status="connected" testId="test-item" />);
    expect(screen.getByTestId('test-item')).toHaveClass('text-green-600');
  });

  it('applies disconnected status styling', () => {
    render(<StatusBarItem label="Disconnected" status="disconnected" testId="test-item" />);
    expect(screen.getByTestId('test-item')).toHaveClass('text-red-600');
  });

  it('applies warning status styling', () => {
    render(<StatusBarItem label="Warning" status="warning" testId="test-item" />);
    expect(screen.getByTestId('test-item')).toHaveClass('text-yellow-600');
  });

  it('animates only the loading icon and respects reduced motion', () => {
    render(<StatusBarItem icon={Database} label="Loading" status="loading" testId="test-item" />);
    const item = screen.getByTestId('test-item');
    expect(item).toHaveClass('text-muted-foreground');
    expect(item).not.toHaveClass('animate-pulse');
    expect(item.querySelector('svg')).toHaveClass('animate-pulse', 'motion-reduce:animate-none');
  });

  it('defaults to connected status when not specified', () => {
    render(<StatusBarItem label="Default" testId="test-item" />);
    expect(screen.getByTestId('test-item')).toHaveClass('text-green-600');
  });

  it('applies custom className', () => {
    render(<StatusBarItem className="custom-class" label="Custom" testId="test-item" />);
    expect(screen.getByTestId('test-item')).toHaveClass('custom-class');
  });

  describe('Snapshots', () => {
    it('renders connected status', () => {
      const { container } = render(
        <StatusBarItem icon={Database} label="Storage: IPC" status="connected" testId="db-status" />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it('renders loading status', () => {
      const { container } = render(
        <StatusBarItem
          icon={Database}
          label="Storage:"
          status="loading"
          testId="db-status"
          value="Connecting..."
        />
      );
      expect(container.firstChild).toMatchSnapshot();
    });

    it('renders disconnected status', () => {
      const { container } = render(
        <StatusBarItem
          icon={Database}
          label="Storage: Error"
          status="disconnected"
          testId="db-status"
        />
      );
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});
