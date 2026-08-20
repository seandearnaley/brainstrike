import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScrollArea } from '../../src/scroll-area';

const viewport = (): HTMLElement | null =>
  document.querySelector('[data-slot="scroll-area-viewport"]');

describe('ScrollArea', () => {
  it('renders content and scrollbar', () => {
    render(
      <ScrollArea>
        <div>Inner</div>
      </ScrollArea>
    );

    expect(screen.getByText('Inner')).toBeInTheDocument();
  });

  // `contentWidth="viewport"` is only meaningful while Radix keeps wrapping the
  // viewport's children in a single div it styles `display: table` inline. If a
  // Radix bump renames, nests or unstyles that wrapper, `[&>div]:!block` stops
  // matching and every consumer silently goes back to overflowing — with the
  // class assertions below still green. So pin the premise, not just the class.
  it('still finds the Radix content wrapper the override targets', () => {
    render(
      <ScrollArea>
        <div>Inner</div>
      </ScrollArea>
    );

    const wrapper = viewport()?.firstElementChild as HTMLElement;
    expect(viewport()?.children).toHaveLength(1);
    expect(wrapper.tagName).toBe('DIV');
    expect(wrapper.style.display).toBe('table');
    expect(wrapper.style.minWidth).toBe('100%');
  });

  it('leaves Radix free to size content past the viewport by default', () => {
    render(
      <ScrollArea>
        <div>Inner</div>
      </ScrollArea>
    );

    expect(viewport()).not.toHaveClass('[&>div]:!block');
  });

  it('overrides the Radix content wrapper to a block box when contentWidth is viewport', () => {
    render(
      <ScrollArea contentWidth="viewport">
        <div>Inner</div>
      </ScrollArea>
    );

    // Radix sets `display: table` inline on that wrapper, so only an
    // `!important` rule can constrain children to the viewport width.
    const wrapper = viewport()?.firstElementChild as HTMLElement;
    expect(viewport()).toHaveClass('[&>div]:!block');
    expect(wrapper.style.display).toBe('table');
  });
});
