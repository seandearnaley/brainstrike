/** True when the user asked the OS to reduce motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)')?.matches === true
  );
}

/**
 * The behaviour for a script-driven smooth scroll. The global CSS
 * reduced-motion override cannot reach an explicit `behavior: 'smooth'`, so
 * callers ask here instead of hardcoding it.
 */
export function smoothScrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
