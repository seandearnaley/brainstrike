'use client';

import { animate } from 'motion';
import { type MotionValue, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useState } from 'react';
import type { CodeFragment } from '@/lib/fragments';

const CENTER_MASK = [
  'linear-gradient(to bottom,',
  'white 0%, white 18%,',
  'transparent 32%, transparent 68%,',
  'white 82%, white 100%)',
].join(' ');

export function RainScene({
  fragments,
  scrollProgress,
}: {
  fragments: CodeFragment[];
  scrollProgress: MotionValue<number>;
}) {
  const [stage, setStage] = useState<'falling' | 'frozen' | 'depth'>('falling');

  useEffect(() => {
    const freezeTimer = setTimeout(() => {
      setStage('frozen');
    }, 2800);

    const depthTimer = setTimeout(() => {
      setStage('depth');
    }, 3200);

    return () => {
      clearTimeout(freezeTimer);
      clearTimeout(depthTimer);
    };
  }, []);

  const containerOpacity = useTransform(scrollProgress, [0, 0.42, 0.46, 1], [1, 1, 0, 0]);

  return (
    <motion.div
      className="absolute inset-0 z-0 overflow-hidden"
      style={{
        perspective: '1200px',
        opacity: containerOpacity,
        maskImage: CENTER_MASK,
        // biome-ignore lint/style/useNamingConvention: vendor-prefixed CSS property
        WebkitMaskImage: CENTER_MASK,
      }}
    >
      {fragments.map((frag) => (
        <FragmentNode fragment={frag} key={frag.id} scrollProgress={scrollProgress} stage={stage} />
      ))}
    </motion.div>
  );
}

function FragmentNode({
  fragment,
  stage,
  scrollProgress,
}: {
  fragment: CodeFragment;
  stage: 'falling' | 'frozen' | 'depth';
  scrollProgress: MotionValue<number>;
}) {
  const [viewportH, setViewportH] = useState(900);
  useEffect(() => {
    setViewportH(window.innerHeight);
  }, []);
  const targetY = (fragment.y / 100) * viewportH;
  const y = useMotionValue(-60);

  useEffect(() => {
    if (stage === 'falling') {
      const controls = animate(y, targetY, {
        duration: fragment.speed,
        delay: 0.2 + fragment.delay,
        ease: 'linear',
      });
      return () => controls.stop();
    }
  }, [stage, fragment.speed, fragment.delay, y, targetY]);

  // Horizontal parallax: closer fragments (higher z) drift further left
  const horizontalRate = -60 - ((fragment.z + 400) / 800) * 350;
  const parallaxX = useTransform(scrollProgress, [0, 0.42], [0, horizontalRate]);

  // After query phase, relevant fragments converge vertically
  const isRelevant = fragment.relevant;
  const queryY = useTransform(scrollProgress, [0.34, 0.42], [targetY, isRelevant ? 200 : targetY]);

  const zTarget = stage === 'depth' ? fragment.z : 0;
  const baseOpacity = 0.15 + ((fragment.z + 400) / 800) * 0.25;

  const queryOpacityTarget = isRelevant ? 1 : 0.03;
  const opacity = useTransform(scrollProgress, [0.34, 0.42], [baseOpacity, queryOpacityTarget]);

  const zScroll = useTransform(scrollProgress, [0.34, 0.42], [zTarget, isRelevant ? 0 : zTarget]);
  const color = useTransform(
    scrollProgress,
    [0.34, 0.42],
    ['#f2ede3', isRelevant ? '#ff9500' : '#f2ede3']
  );

  return (
    <motion.div
      className="absolute top-0 whitespace-pre font-mono text-xs will-change-transform sm:text-sm md:text-base"
      style={{
        left: `${fragment.x}%`,
        y: stage === 'falling' ? y : queryY,
        x: parallaxX,
        z: zScroll,
        opacity,
        color,
      }}
    >
      {fragment.text}
    </motion.div>
  );
}
