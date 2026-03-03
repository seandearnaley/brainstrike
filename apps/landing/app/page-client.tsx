'use client';

import { motion, useScroll, useTransform } from 'motion/react';
import { useCallback, useState } from 'react';
import { ArsenalScene } from '@/components/scenes/arsenal-scene';
import { HeroScene } from '@/components/scenes/hero-scene';
import { PipelineScene } from '@/components/scenes/pipeline-scene';
import { QueryScene } from '@/components/scenes/query-scene';
import { RainScene } from '@/components/scenes/rain-scene';
import { ResponseScene } from '@/components/scenes/response-scene';
import type { CodeFragment } from '@/lib/fragments';

const VIGNETTE =
  'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 50%, rgba(12,11,9,0.6) 100%)';

export function LandingPageClient({ fragments }: { fragments: CodeFragment[] }) {
  const [heroComplete, setHeroComplete] = useState(false);
  const handleHeroComplete = useCallback(() => setHeroComplete(true), []);

  const { scrollYProgress } = useScroll();

  const heroOpacity = useTransform(scrollYProgress, [0, 0.06, 0.08, 1], [1, 1, 0, 0]);
  const heroY = useTransform(scrollYProgress, [0, 0.08], [0, -80]);
  const progressScaleX = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return (
    <main className="relative bg-[var(--color-void)]">
      <div className="w-full" style={{ height: '10000px' }} />

      {/* Scroll progress bar */}
      <motion.div
        className="fixed top-0 right-0 left-0 z-[60] h-[2px] origin-left bg-[var(--color-amber)]"
        style={{ scaleX: progressScaleX }}
      />

      {/* Vignette overlay */}
      <div className="pointer-events-none fixed inset-0 z-[45]" style={{ background: VIGNETTE }} />

      <div className="pointer-events-none fixed inset-0">
        <motion.div className="absolute inset-0" style={{ opacity: heroOpacity, y: heroY }}>
          <HeroScene onComplete={handleHeroComplete} />
        </motion.div>

        {heroComplete && (
          <>
            <RainScene fragments={fragments} scrollProgress={scrollYProgress} />
            <PipelineScene scrollProgress={scrollYProgress} />
            <QueryScene scrollProgress={scrollYProgress} />
            <ResponseScene scrollProgress={scrollYProgress} />
            <ArsenalScene scrollProgress={scrollYProgress} />
          </>
        )}
      </div>
    </main>
  );
}
