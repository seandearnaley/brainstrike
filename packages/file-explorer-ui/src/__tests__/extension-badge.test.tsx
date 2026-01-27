import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExtensionBadge } from '../extension-badge';

describe('ExtensionBadge', () => {
  it('renders the extension text', () => {
    render(<ExtensionBadge extension="TSX" />);
    expect(screen.getByText('TSX')).toBeInTheDocument();
  });

  it('applies hash-based color styles for light and dark themes', () => {
    const { container } = render(<ExtensionBadge extension="JS" />);
    const badge = container.firstElementChild as HTMLElement;

    expect(badge.style.getPropertyValue('--ext-bg')).toBeTruthy();
    expect(badge.style.getPropertyValue('--ext-text')).toBeTruthy();
    expect(badge.style.getPropertyValue('--ext-dark-bg')).toBeTruthy();
    expect(badge.style.getPropertyValue('--ext-dark-text')).toBeTruthy();
  });

  it('produces consistent colors for the same extension', () => {
    const { container: c1 } = render(<ExtensionBadge extension="PY" />);
    const { container: c2 } = render(<ExtensionBadge extension="PY" />);

    const badge1 = c1.firstElementChild as HTMLElement;
    const badge2 = c2.firstElementChild as HTMLElement;

    expect(badge1.style.getPropertyValue('--ext-bg')).toBe(
      badge2.style.getPropertyValue('--ext-bg')
    );
  });

  it('renders a title attribute for truncated extensions', () => {
    render(<ExtensionBadge extension="DOCKERFILE" />);
    const badge = screen.getByTitle('DOCKERFILE');
    expect(badge).toBeInTheDocument();
  });

  it('renders FILE for extensionless files', () => {
    render(<ExtensionBadge extension="FILE" />);
    expect(screen.getByText('FILE')).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(<ExtensionBadge className="custom-class" extension="MD" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('custom-class');
  });

  it('renders compact size with smaller styling', () => {
    const { container } = render(<ExtensionBadge extension="JS" size="compact" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('py-0');
    expect(badge.className).toContain('leading-tight');
  });

  it('defaults to default size', () => {
    const { container } = render(<ExtensionBadge extension="JS" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('py-0.5');
  });
});
