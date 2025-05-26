import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageWrapper } from '../page-wrapper';

describe('PageWrapper', () => {
  it('renders title and children', () => {
    render(
      <PageWrapper title="My Title">
        <p>Content</p>
      </PageWrapper>
    );

    expect(screen.getByRole('heading', { name: 'My Title' })).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
    expect(screen.queryByText('Desc')).not.toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <PageWrapper title="With Description" description="Desc">
        <span />
      </PageWrapper>
    );

    expect(screen.getByText('Desc')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <PageWrapper title="Class" className="extra">
        <span />
      </PageWrapper>
    );

    expect(container.firstChild).toHaveClass('extra');
  });
});
