'use client';

import { type MotionValue, motion, useTransform } from 'motion/react';

export function QueryScene({ scrollProgress }: { scrollProgress: MotionValue<number> }) {
  const searchRevealPct = useTransform(scrollProgress, [0.3, 0.38], [100, 0]);
  const searchBarClip = useTransform(searchRevealPct, (v) => `inset(0% ${v}% 0% 0%)`);
  const searchBarOpacity = useTransform(scrollProgress, [0, 0.28, 0.3, 1], [0, 0, 1, 1]);

  const leftBorderOpacity = useTransform(
    scrollProgress,
    [0, 0.37, 0.38, 0.4, 0.41, 1],
    [0, 0, 1, 1, 0, 0]
  );

  const fullQuery = '> which functions handle the embedding queue?';
  const queryLength = fullQuery.length;
  const charCount = useTransform(scrollProgress, [0.34, 0.42], [0, queryLength]);
  const queryText = useTransform(charCount, (c) => fullQuery.slice(0, Math.floor(c)));
  const cursorOpacity = useTransform(scrollProgress, [0.42, 0.43], [1, 0]);

  const containerY = useTransform(scrollProgress, [0.48, 0.52], ['0vh', '-40vh']);
  const containerScale = useTransform(scrollProgress, [0.48, 0.52], [1, 0.8]);
  const sceneOpacity = useTransform(
    scrollProgress,
    [0, 0.26, 0.3, 0.5, 0.54, 1],
    [0, 0, 1, 1, 0, 0]
  );

  const finalCopyOpacity = useTransform(
    scrollProgress,
    [0, 0.38, 0.4, 0.48, 0.5, 1],
    [0, 0, 1, 1, 0, 0]
  );
  const finalCopyY = useTransform(scrollProgress, [0.38, 0.4], [12, 0]);

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center"
      style={{ y: containerY, scale: containerScale, opacity: sceneOpacity }}
    >
      <div className="flex w-full max-w-3xl flex-col items-center px-8">
        <motion.div
          className="relative flex h-16 w-full items-center border border-[var(--color-newsprint)] bg-[var(--color-ghost)] px-6"
          style={{ clipPath: searchBarClip, opacity: searchBarOpacity }}
        >
          <motion.div
            className="absolute top-0 bottom-0 left-0 w-1 bg-[var(--color-amber)]"
            style={{ opacity: leftBorderOpacity }}
          />

          <motion.span className="font-mono text-[var(--color-newsprint)] text-lg">
            {queryText}
          </motion.span>
          <motion.div
            className="ml-1 h-5 w-2 animate-cursor-blink bg-[var(--color-amber)]"
            style={{ opacity: cursorOpacity }}
          />
        </motion.div>

        <motion.div
          className="mt-32 text-center font-[family-name:var(--font-display)] text-[var(--color-muted)] text-xl uppercase tracking-[0.15em] md:text-2xl"
          style={{ opacity: finalCopyOpacity, y: finalCopyY }}
        >
          Semantic search. No cloud. No API keys. Your machine.
        </motion.div>
      </div>
    </motion.div>
  );
}
