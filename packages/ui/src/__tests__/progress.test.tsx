import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { Progress } from '../../src/progress';

describe('Progress', () => {
  it('sets bar transform based on value', () => {
    const { container } = render(<Progress value={40} />);
    const bar = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('style')).toContain('translateX(-60%)');
  });

  it('preserves required progressbar aria semantics even when props include overrides', () => {
    const overrideProps = {
      'aria-valuemax': 5,
      'aria-valuemin': 1,
      'aria-valuenow': 2,
      role: 'presentation',
    } as unknown as ComponentProps<typeof Progress>;

    render(<Progress {...overrideProps} value={40} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuenow', '40');
  });
});
