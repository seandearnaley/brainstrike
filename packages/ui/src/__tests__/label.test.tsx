import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Label } from '../../src/label';

describe('Label', () => {
  it('associates htmlFor attribute', () => {
    render(<Label htmlFor="input-id">Label Text</Label>);
    const label = screen.getByText('Label Text');
    expect(label).toHaveAttribute('for', 'input-id');
  });

  it('applies custom className', () => {
    render(
      <Label className="custom" htmlFor="x">
        Text
      </Label>
    );
    const label = screen.getByText('Text');
    expect(label).toHaveClass('custom');
  });
});
