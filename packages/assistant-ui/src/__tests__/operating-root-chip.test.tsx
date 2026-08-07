import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OperatingRootChip } from '../operating-root-chip';

describe('OperatingRootChip', () => {
  it('renders nothing when no operating root is provided (single-root / web)', () => {
    render(<OperatingRootChip />);

    expect(screen.queryByTestId('operating-root-chip')).toBeNull();
  });

  it('renders "in {displayName}" with the path as a tooltip title', () => {
    render(
      <OperatingRootChip operatingRoot={{ displayName: 'ProjectA', path: '/Users/me/ProjectA' }} />
    );

    const chip = screen.getByTestId('operating-root-chip');
    expect(chip).toHaveTextContent('in ProjectA');
    expect(chip).toHaveAttribute('title', '/Users/me/ProjectA');
  });

  it('renders without a title when the root has no absolute path (web FSA)', () => {
    render(<OperatingRootChip operatingRoot={{ displayName: 'web-folder' }} />);

    const chip = screen.getByTestId('operating-root-chip');
    expect(chip).toHaveTextContent('in web-folder');
    expect(chip).not.toHaveAttribute('title');
  });
});
