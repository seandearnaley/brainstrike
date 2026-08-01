import { useEffect } from 'react';
import { computeSectionScrollTop } from './section-scroll';

function scrollToSectionFrame(hash: string, behavior: ScrollBehavior): boolean {
  if (!(hash.length > 1 && hash.startsWith('#'))) {
    return false;
  }

  const target = document.getElementById(hash.slice(1));
  if (!(target instanceof HTMLElement && target.hasAttribute('data-scroll-section'))) {
    return false;
  }

  const maximumScrollTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const top = computeSectionScrollTop({
    maximumScrollTop,
    sectionDocumentTop: target.getBoundingClientRect().top + window.scrollY,
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
      scrollToSectionFrame(window.location.hash, 'auto');
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
      if (!scrollToSectionFrame(url.hash, behavior)) {
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
