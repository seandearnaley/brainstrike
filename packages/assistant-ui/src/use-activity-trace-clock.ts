import { useEffect, useRef, useState } from 'react';

/**
 * Live elapsed timer. While `isActive`, ticks every 100ms, SEEDED from the
 * turn's already-elapsed run-event span so it continues from there instead of
 * resetting to 0 (which otherwise flashes e.g. 1.8s → 0.2s the moment the group
 * mounts mid-turn). Once inactive it freezes the measured value; a turn never
 * observed live (reloaded/finished) just returns `fallbackMs`. Reactivation of
 * this same mounted group preserves its accumulated live activity time.
 *
 * Lives in its own `use-*.ts` module (BST-1684) so `activity-trace.tsx` exports
 * components only — the Fast Refresh boundary rule.
 */
export function useElapsedMs(
  isActive: boolean,
  fallbackMs: number | undefined
): number | undefined {
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  // Latest seed value, mirrored in an effect (not render, to keep render pure)
  // and read once when activity starts — so a growing fallback never restarts
  // the clock.
  const seedRef = useRef(fallbackMs);
  const accumulatedRef = useRef(0);
  useEffect(() => {
    seedRef.current = fallbackMs;
  }, [fallbackMs]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    // Anchor the clock to the turn's real start: now − elapsed-so-far.
    const start = Date.now() - Math.max(seedRef.current ?? 0, accumulatedRef.current);
    setMeasuredMs(Date.now() - start);
    const intervalId = setInterval(() => setMeasuredMs(Date.now() - start), 100);
    return () => {
      accumulatedRef.current = Date.now() - start;
      setMeasuredMs(accumulatedRef.current);
      clearInterval(intervalId);
    };
  }, [isActive]);

  return measuredMs ?? fallbackMs;
}
