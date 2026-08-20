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

  it('leaves Radix free to size content past the viewport by default', () => {
    render(
      <ScrollArea>
        <div>Inner</div>
      </ScrollArea>
    );

    expect(viewport()).not.toHaveClass('[&>div]:!block');
  });

  it('overrides the Radix content wrapper to a block box when axis is vertical', () => {
    render(
      <ScrollArea axis="vertical">
        <div>Inner</div>
      </ScrollArea>
    );

    // Radix hard-codes `display: table` inline on that wrapper, so only an
    // `!important` rule can constrain children to the viewport width.
    expect(viewport()).toHaveClass('[&>div]:!block');
  });
});
