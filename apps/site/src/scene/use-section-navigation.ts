import { useEffect } from 'react';
import { computeSectionScrollTop } from './section-scroll';

const DESKTOP_VIEWPORT_GAP = 24;
const MOBILE_VIEWPORT_GAP = 16;
const MOBILE_BREAKPOINT = 520;

function scrollToMeasuredSection(hash: string, behavior: ScrollBehavior): boolean {
  if (!(hash.length > 1 && hash.startsWith('#'))) {
    return false;
  }

  const target = document.getElementById(hash.slice(1));
  if (!(target instanceof HTMLElement && target.hasAttribute('data-scroll-section'))) {
    return false;
  }

  const content = target.querySelector<HTMLElement>('[data-scroll-content]');
  if (!content) {
    throw new Error(`Measured section "${target.id}" requires a data-scroll-content element.`);
  }

  const header = document.querySelector<HTMLElement>('.site-header');
  if (!header) {
    throw new Error('Measured section navigation requires the fixed site header.');
  }

  const contentRect = content.getBoundingClientRect();
  const headerHeight = header.getBoundingClientRect().bottom;
  const viewportGap =
    window.innerWidth <= MOBILE_BREAKPOINT ? MOBILE_VIEWPORT_GAP : DESKTOP_VIEWPORT_GAP;
  const maximumScrollTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const top = computeSectionScrollTop({
    contentDocumentTop: contentRect.top + window.scrollY,
    contentHeight: contentRect.height,
    headerHeight,
    maximumScrollTop,
    viewportGap,
    viewportHeight: window.innerHeight,
  });

  window.scrollTo({ behavior, top });
  return true;
}

function isPlainPrimaryActivation(event: MouseEvent): boolean {
  return !(event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

export function useSectionNavigation(): void {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let active = true;

    const navigateFromLocation = (): void => {
      if (!active) {
        return;
      }
      scrollToMeasuredSection(window.location.hash, 'auto');
    };

    const handleClick = (event: MouseEvent): void => {
      if (!(isPlainPrimaryActivation(event) && event.target instanceof Element)) {
        return;
      }

      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link) {
        return;
      }

      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== window.location.pathname ||
        url.search !== window.location.search ||
        !url.hash
      ) {
        return;
      }

      const behavior: ScrollBehavior = reducedMotion.matches ? 'auto' : 'smooth';
      if (!scrollToMeasuredSection(url.hash, behavior)) {
        return;
      }

      event.preventDefault();
      if (window.location.hash !== url.hash) {
        window.history.pushState(null, '', url.hash);
      }
    };

    document.addEventListener('click', handleClick);
    window.addEventListener('hashchange', navigateFromLocation);
    window.addEventListener('popstate', navigateFromLocation);
    void document.fonts.ready.then(() => requestAnimationFrame(navigateFromLocation));

    return () => {
      active = false;
      document.removeEventListener('click', handleClick);
      window.removeEventListener('hashchange', navigateFromLocation);
      window.removeEventListener('popstate', navigateFromLocation);
    };
  }, []);
}
