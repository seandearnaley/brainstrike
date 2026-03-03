'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';

type Stage = 'void' | 'typing' | 'headline-complete';

const HEADLINE = 'THINK FAST.';
const SUBTITLE = 'Search everything you know.';

// Pre-compute with stable composite keys (char + position) — these static arrays never reorder.
const HEADLINE_CHARS = HEADLINE.split('').map((char, i) => ({ char, id: `h${i}` }));
const SUBTITLE_CHARS = SUBTITLE.split('').map((char, i) => ({ char, id: `s${i}` }));

export function HeroScene({ onComplete }: { onComplete: () => void }) {
  const [stage, setStage] = useState<Stage>('void');

  useEffect(() => {
    const t1 = setTimeout(() => setStage('typing'), 800);
    const t2 = setTimeout(() => {
      setStage('headline-complete');
      onComplete();
    }, 2500);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [onComplete]);

  return (
    <div className="relative flex h-screen w-full flex-col items-center justify-center bg-transparent">
      <AnimatePresence mode="wait">
        {stage === 'void' && (
          <motion.div
            className="absolute flex h-full w-full items-center justify-center"
            exit={{ opacity: 0 }}
            key="void-cursor"
            transition={{ duration: 0.15 }}
          >
            <div className="h-[6vw] min-h-[4rem] w-[4vw] min-w-[2rem] animate-cursor-blink bg-[var(--color-amber)]" />
          </motion.div>
        )}
      </AnimatePresence>

      {stage !== 'void' && (
        <motion.div
          animate={{ opacity: 1 }}
          className="relative z-10 flex w-full max-w-7xl flex-col items-center px-8"
          initial={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <h1 className="flex font-[family-name:var(--font-display)] text-[clamp(5rem,12vw,10rem)] uppercase leading-none tracking-[0.04em]">
            {HEADLINE_CHARS.map(({ char, id }, i) => (
              <motion.span
                animate={{ opacity: 1, y: 0 }}
                className="inline-block whitespace-pre"
                initial={{ opacity: 0, y: 6 }}
                key={id}
                transition={{
                  opacity: { delay: i * 0.06, duration: 0.01 },
                  y: { delay: i * 0.06, duration: 0.12, ease: 'easeOut' },
                }}
              >
                {char}
              </motion.span>
            ))}
          </h1>

          <div className="mt-6 flex flex-col items-center gap-5">
            <h2 className="flex font-[family-name:var(--font-mono)] text-[var(--color-muted)] text-xl tracking-[0.06em] md:text-2xl">
              {SUBTITLE_CHARS.map(({ char, id }, i) => (
                <motion.span
                  animate={{ opacity: 1 }}
                  className="inline-block whitespace-pre"
                  initial={{ opacity: 0 }}
                  key={id}
                  transition={{ delay: 1.0 + i * 0.025, duration: 0.01 }}
                >
                  {char}
                </motion.span>
              ))}
            </h2>

            <AnimatePresence>
              {stage === 'headline-complete' && (
                <motion.div
                  animate={{ scaleX: 1 }}
                  className="h-[3px] w-full max-w-sm bg-[var(--color-amber)]"
                  initial={{ scaleX: 0 }}
                  style={{ originX: 0 }}
                  transition={{ type: 'spring', stiffness: 800, damping: 60, delay: 0.1 }}
                />
              )}
            </AnimatePresence>

            <motion.p
              animate={{ opacity: 1 }}
              className="font-[family-name:var(--font-mono)] text-[var(--color-muted)] text-xs uppercase tracking-widest md:text-sm"
              initial={{ opacity: 0 }}
              transition={{ delay: 2.2, duration: 0.6 }}
            >
              scroll to explore ↓
            </motion.p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
