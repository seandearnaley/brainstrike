import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExtensionBadge } from '../extension-badge';

describe('ExtensionBadge', () => {
  it('renders the extension text', () => {
    render(<ExtensionBadge extension="tsx" />);
    expect(screen.getByText('tsx')).toBeInTheDocument();
  });

  it('applies hash-based color styles for light and dark themes', () => {
    const { container } = render(<ExtensionBadge extension="js" />);
    const badge = container.firstElementChild as HTMLElement;
    const hexColor = /^#[0-9A-Fa-f]{6}$/;

    expect(badge.style.getPropertyValue('--extension-badge-bg')).toMatch(hexColor);
    expect(badge.style.getPropertyValue('--extension-badge-text')).toMatch(hexColor);
    expect(badge.style.getPropertyValue('--extension-badge-dark-bg')).toMatch(hexColor);
    expect(badge.style.getPropertyValue('--extension-badge-dark-text')).toMatch(hexColor);
  });

  it('produces consistent colors for the same extension', () => {
    const { container: c1 } = render(<ExtensionBadge extension="py" />);
    const { container: c2 } = render(<ExtensionBadge extension="py" />);

    const badge1 = c1.firstElementChild as HTMLElement;
    const badge2 = c2.firstElementChild as HTMLElement;

    expect(badge1.style.getPropertyValue('--extension-badge-bg')).toBe(
      badge2.style.getPropertyValue('--extension-badge-bg')
    );
  });

  it('renders a title attribute for truncated extensions', () => {
    render(<ExtensionBadge extension="dockerfile" />);
    const badge = screen.getByTitle('dockerfile');
    expect(badge).toBeInTheDocument();
  });

  it('renders file label for extensionless files', () => {
    render(<ExtensionBadge extension="file" />);
    expect(screen.getByText('file')).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(<ExtensionBadge className="custom-class" extension="md" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('custom-class');
  });

  it('renders compact size with smaller styling', () => {
    const { container } = render(<ExtensionBadge extension="js" size="compact" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('py-0');
    expect(badge.className).toContain('leading-tight');
  });

  it('defaults to default size', () => {
    const { container } = render(<ExtensionBadge extension="js" />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain('py-0.5');
  });

  it('applies uppercase CSS class for visual display', () => {
    const { container } = render(<ExtensionBadge extension="tsx" />);
    const span = container.querySelector('span');
    expect(span?.className).toContain('uppercase');
  });
});
