import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExpandableMessageContent } from '../expandable-message-content';

const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight'
);

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
});

afterEach(() => {
  if (scrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
  }
});

function setScrollHeight(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => px,
  });
}

describe('ExpandableMessageContent', () => {
  it('shows a Show more toggle when content overflows and expands on click', () => {
    setScrollHeight(500); // > collapsedHeight
    render(
      <ExpandableMessageContent className="x" collapsedHeight={176} testId="exp">
        <p>long content</p>
      </ExpandableMessageContent>
    );

    expect(screen.getByTestId('exp')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show more message content' });
    expect(toggle).toHaveTextContent('Show more');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less message content' })).toHaveTextContent(
      'Show less'
    );
  });

  it('renders no toggle when the content fits within the collapsed height', () => {
    setScrollHeight(100); // < collapsedHeight
    render(
      <ExpandableMessageContent className="x" collapsedHeight={176}>
        <p>short</p>
      </ExpandableMessageContent>
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
