import { useEffect, useState } from 'react';

/**
 * V2-only: exposes the current visible row paths maintained by the optimized tree.
 * Internally listens to a window event published by the V2 component.
 * Returns a stable reference that only changes on expand/collapse or filter commits.
 */
export function useVisibleRowsV2(): { rows: string[] } {
  const [rows, setRows] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    return Array.isArray(window.__v2VisibleRowsPaths) ? window.__v2VisibleRowsPaths : [];
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      if (Array.isArray(window.__v2VisibleRowsPaths)) setRows(window.__v2VisibleRowsPaths);
    };
    window.addEventListener('v2-visible-rows-updated', handler);
    return () => window.removeEventListener('v2-visible-rows-updated', handler);
  }, []);

  return { rows };
}
