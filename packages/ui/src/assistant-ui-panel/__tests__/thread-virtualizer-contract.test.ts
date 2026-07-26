import { Virtualizer } from '@tanstack/react-virtual';
import { describe, expect, it } from 'vitest';

/**
 * BST-897: the virtualized thread tier depends on TanStack Virtual's
 * END-ANCHORED chat APIs, which landed in @tanstack/virtual-core 3.17.
 *
 * The workspace catalog pins the REACT ADAPTER (`^3.14.6`), and the adapter is
 * what pins core — 3.14.6 declares an exact `"@tanstack/virtual-core": "3.17.4"`.
 * Nothing in the manifest states the requirement the renderer actually has, and
 * `setOptions` silently SPREADS unknown option keys: an adapter bump that dragged
 * in an older core would drop `anchorTo` / `followOnAppend` / `scrollEndThreshold`
 * with no throw and no warning, while `data-thread-render-tier="virtual"` kept
 * reporting success. That is the silent-degradation shape AGENTS.md rules out,
 * so the requirement is asserted against the RESOLVED package here instead.
 *
 * This deliberately checks behaviour, not a version string: the options must
 * survive `setOptions`, and the end-anchor query/command methods must exist.
 */
describe('TanStack Virtual end-anchored chat API (BST-897)', () => {
  const buildVirtualizer = () =>
    new Virtualizer<HTMLDivElement, HTMLDivElement>({
      anchorTo: 'end',
      count: 3,
      estimateSize: () => 120,
      followOnAppend: 'instant',
      getScrollElement: () => null,
      observeElementOffset: () => undefined,
      observeElementRect: () => undefined,
      scrollEndThreshold: 24,
      scrollToFn: () => undefined,
    });

  it('knows the end-anchoring options natively rather than merely carrying them', () => {
    // `setOptions` spreads EVERY supplied key onto its merged options, so reading
    // back what we passed proves nothing — an older core would echo `anchorTo`
    // straight back while ignoring it. The DEFAULTS are the real probe: a core
    // that predates end-anchored chat mode has no defaults for these keys.
    const defaults = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count: 0,
      estimateSize: () => 120,
      getScrollElement: () => null,
      observeElementOffset: () => undefined,
      observeElementRect: () => undefined,
      scrollToFn: () => undefined,
    });

    expect(defaults.options.anchorTo).toBe('start');
    expect(defaults.options.followOnAppend).toBe(false);
    expect(defaults.options.scrollEndThreshold).toBe(1);

    // …and the renderer's own values are what the instance ends up running with.
    const virtualizer = buildVirtualizer();
    expect(virtualizer.options.anchorTo).toBe('end');
    expect(virtualizer.options.followOnAppend).toBe('instant');
    expect(virtualizer.options.scrollEndThreshold).toBe(24);
  });

  it('exposes the end-position query and command methods the jump button drives', () => {
    const virtualizer = buildVirtualizer();

    expect(typeof virtualizer.isAtEnd).toBe('function');
    expect(typeof virtualizer.getDistanceFromEnd).toBe('function');
    expect(typeof virtualizer.scrollToEnd).toBe('function');
    expect(typeof virtualizer.measureElement).toBe('function');
  });
});
