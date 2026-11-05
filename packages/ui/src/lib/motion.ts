/**
 * Whether motion should be reduced: the device asks for it, or the user picked
 * Reduced motion in Settings > Appearance (the theme provider's
 * `data-motion="reduce"` on <html>). For script-driven motion that the CSS
 * reduced-motion rules cannot reach, such as an explicit smooth scroll.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset['motion'] === 'reduce') {
    return true;
  }
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
  );
}
