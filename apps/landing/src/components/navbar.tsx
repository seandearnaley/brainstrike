import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';

const NAV_LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'Local-First', href: '#local-first' },
  { label: 'Architecture', href: '#architecture' },
] as const;

export function Navbar(): React.JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = (): void => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToTop = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <nav
      className="fixed inset-x-0 top-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? 'oklch(0.14 0.006 65 / 0.92)' : 'transparent',
        borderBottom: scrolled ? '1px solid var(--border-subtle)' : '1px solid transparent',
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        {/* Logo */}
        <a
          className="font-bold text-xl tracking-tight"
          href="/"
          onClick={scrollToTop}
          style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
        >
          Brain<span className="accent-text">Strike</span>
        </a>

        {/* Desktop links */}
        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              className="text-sm transition-colors duration-200 hover:text-white"
              href={link.href}
              key={link.href}
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
            >
              {link.label}
            </a>
          ))}
          <a
            className="rounded-lg px-4 py-2 font-medium text-sm transition-all duration-200 hover:brightness-110"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              background: 'var(--accent)',
              color: 'white',
            }}
            target="_blank"
          >
            Get Started
          </a>
        </div>

        {/* Mobile menu toggle */}
        <button
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          className="md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          style={{ color: 'var(--text-primary)' }}
          type="button"
        >
          {mobileOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          className="border-t px-6 pt-2 pb-6 md:hidden"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'oklch(0.14 0.006 65 / 0.95)',
          }}
        >
          {NAV_LINKS.map((link) => (
            <a
              className="block py-3 text-sm transition-colors duration-200 hover:text-white"
              href={link.href}
              key={link.href}
              onClick={() => setMobileOpen(false)}
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}
            >
              {link.label}
            </a>
          ))}
          <a
            className="mt-3 block rounded-lg px-4 py-2.5 text-center font-medium text-sm transition-all duration-200 hover:brightness-110"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              background: 'var(--accent)',
              color: 'white',
            }}
            target="_blank"
          >
            Get Started
          </a>
        </div>
      )}
    </nav>
  );
}
