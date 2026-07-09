import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBar } from '../status-bar';

describe('StatusBar', () => {
  it('renders with data-testid', () => {
    render(<StatusBar />);
    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
  });

  it('renders left content', () => {
    render(<StatusBar leftContent={<span>Left Item</span>} />);
    expect(screen.getByText('Left Item')).toBeInTheDocument();
  });

  it('renders right content', () => {
    render(<StatusBar rightContent={<span>Right Item</span>} />);
    expect(screen.getByText('Right Item')).toBeInTheDocument();
  });

  it('renders center content when provided', () => {
    render(<StatusBar centerContent={<span>Center Item</span>} />);
    expect(screen.getByText('Center Item')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar-center')).toBeInTheDocument();
  });

  it('does not render center section when centerContent is not provided', () => {
    render(<StatusBar />);
    expect(screen.queryByTestId('status-bar-center')).not.toBeInTheDocument();
  });

  it('uses a footer landmark without making every high-frequency update a live announcement', () => {
    render(<StatusBar />);
    const statusBar = screen.getByTestId('status-bar');
    expect(statusBar.tagName.toLowerCase()).toBe('footer');
    expect(statusBar).not.toHaveAttribute('aria-live');
  });

  it('uses a stable three-column grid so changing edge content cannot move the center slot', () => {
    render(
      <StatusBar
        centerContent={<span>Center</span>}
        leftContent={<span>Left</span>}
        rightContent={<span>Right</span>}
      />
    );

    expect(screen.getByTestId('status-bar')).toHaveClass(
      'grid',
      'grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
    );
    expect(screen.getByTestId('status-bar-left')).toHaveClass('justify-self-start');
    expect(screen.getByTestId('status-bar-center')).toHaveClass('justify-self-center');
    expect(screen.getByTestId('status-bar-right')).toHaveClass('justify-self-end');
  });

  it('applies custom className', () => {
    render(<StatusBar className="custom-class" />);
    expect(screen.getByTestId('status-bar')).toHaveClass('custom-class');
  });

  it('renders left and right content together', () => {
    render(<StatusBar leftContent={<span>Left</span>} rightContent={<span>Right</span>} />);
    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.getByText('Right')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar-left')).toContainElement(screen.getByText('Left'));
    expect(screen.getByTestId('status-bar-right')).toContainElement(screen.getByText('Right'));
  });

  describe('Snapshots', () => {
    it('renders empty status bar', () => {
      const { container } = render(<StatusBar />);
      expect(container.firstChild).toMatchSnapshot();
    });

    it('renders with all slots filled', () => {
      const { container } = render(
        <StatusBar
          centerContent={<span>Center</span>}
          leftContent={<span>Left</span>}
          rightContent={<span>Right</span>}
        />
      );
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});
