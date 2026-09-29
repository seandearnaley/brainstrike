import { getAgentColorStyles } from '@brainstrike/types/agent-color';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThreadColorFamilyPreview } from '../thread-color-family-preview';

describe('ThreadColorFamilyPreview', () => {
  it('shows a decorative family for the selected root color', () => {
    const { container } = render(<ThreadColorFamilyPreview rootColor="rose" />);
    expect(screen.getByText('New agents get distinct, related colors.')).toBeVisible();
    expect(screen.getByText(/one root agent branches to three child agents/i)).toBeInTheDocument();
    expect(
      screen.getByText('Changing this color sets the starting point for new agents.')
    ).toBeVisible();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const graph = container.querySelector('svg');
    expect(graph).toHaveAttribute('aria-hidden', 'true');
    const circles = graph?.querySelectorAll('circle');
    expect(circles).toHaveLength(6);
    expect(new Set(Array.from(circles ?? [], (circle) => circle.getAttribute('style'))).size).toBe(
      6
    );
    expect(circles?.[0]?.getAttribute('style')).toContain(
      getAgentColorStyles('rose')['--agent-accent-light']
    );
  });

  it('changes descendants with the root color and uses blue when unassigned', () => {
    const { container, rerender } = render(<ThreadColorFamilyPreview rootColor={null} />);
    const circles = (): NodeListOf<SVGCircleElement> => container.querySelectorAll('circle');
    expect(circles()[0]?.getAttribute('style')).toContain(
      getAgentColorStyles('blue')['--agent-accent-light']
    );
    const blueChild = circles()[1]?.getAttribute('style');
    rerender(<ThreadColorFamilyPreview rootColor="violet" />);
    expect(circles()[1]?.getAttribute('style')).not.toBe(blueChild);
  });
});
