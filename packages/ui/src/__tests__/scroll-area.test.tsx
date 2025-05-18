import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScrollArea } from '../../src/scroll-area';

describe('ScrollArea', () => {
  it('renders content and scrollbar', () => {
    render(
      <ScrollArea>
        <div>Inner</div>
      </ScrollArea>
    );

    expect(screen.getByText('Inner')).toBeInTheDocument();
  });
});
