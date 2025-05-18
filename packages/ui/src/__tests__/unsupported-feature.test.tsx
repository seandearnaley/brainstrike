import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UnsupportedFeature } from '../unsupported-feature';

describe('UnsupportedFeature', () => {
  it('renders title and description', () => {
    const { getByText, container } = render(
      <UnsupportedFeature title="Unsupported" description="Not supported here." />
    );

    expect(getByText('Unsupported')).toBeInTheDocument();
    expect(getByText('Not supported here.')).toBeInTheDocument();

    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('p-8');
    expect(root).toHaveClass('max-w-2xl');
    expect(root).toHaveClass('mx-auto');
  });
});
