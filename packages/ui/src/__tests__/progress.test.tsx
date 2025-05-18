import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Progress } from '../../src/progress';

describe('Progress', () => {
  it('sets bar transform based on value', () => {
    const { container } = render(<Progress value={40} />);
    const bar = container.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('style')).toContain('translateX(-60%)');
  });
});
