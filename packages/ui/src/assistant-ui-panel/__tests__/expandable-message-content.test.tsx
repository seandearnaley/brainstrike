import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExpandableMessageContent } from '../expandable-message-content';

const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollHeight'
);
let currentScrollHeight = 0;
let observedElement: Element | null = null;
let resizeCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  currentScrollHeight = 0;
  observedElement = null;
  resizeCallback = null;
  global.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }

    disconnect() {}

    observe(element: Element) {
      observedElement = element;
    }

    unobserve() {}
  } as never;
});

afterEach(() => {
  if (scrollHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
  }
});

function setScrollHeight(px: number) {
  currentScrollHeight = px;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => currentScrollHeight,
  });
}

describe('ExpandableMessageContent', () => {
  it('shows a Show more toggle when content overflows and expands on click', () => {
    setScrollHeight(500); // > collapsedHeight
    const { container } = render(
      <ExpandableMessageContent className="x" collapsedHeight={176} testId="exp">
        <p>long content</p>
      </ExpandableMessageContent>
    );

    expect(screen.getByTestId('exp')).toBeInTheDocument();
    const body = container.querySelector<HTMLElement>('.bs-expandable-message-body');
    const content = container.querySelector<HTMLElement>('.bs-expandable-message-content');
    expect(body).not.toBeNull();
    expect(content).not.toBeNull();
    expect(observedElement).toBe(content);
    expect(body).toHaveStyle({ maxHeight: '176px' });

    const toggle = screen.getByRole('button', { name: 'Show more message content' });
    expect(toggle).toHaveTextContent('Show more');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less message content' })).toHaveTextContent(
      'Show less'
    );
    expect(body?.style.maxHeight).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Show less message content' }));
    expect(body).toHaveStyle({ maxHeight: '176px' });
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

  it('remeasures asynchronously resizing inner content', () => {
    setScrollHeight(100);
    const { container } = render(
      <ExpandableMessageContent className="x" collapsedHeight={176}>
        <p>content that grows after markdown or an image loads</p>
      </ExpandableMessageContent>
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(resizeCallback).not.toBeNull();

    currentScrollHeight = 480;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(screen.getByRole('button', { name: 'Show more message content' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show more message content' }));
    const body = container.querySelector<HTMLElement>('.bs-expandable-message-body');
    expect(body?.style.maxHeight).toBe('');

    currentScrollHeight = 640;
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });
    expect(body?.style.maxHeight).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Show less message content' }));
    expect(body).toHaveStyle({ maxHeight: '176px' });
  });
});
