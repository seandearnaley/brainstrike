import { useScroll, useTransform } from 'motion/react';
import type { RefObject } from 'react';

interface ScrollProgressOptions {
  target: RefObject<HTMLElement | null>;
  offset?: [string, string];
}

interface ScrollProgressResult {
  progress: ReturnType<typeof useTransform<number, number>>;
}

export function useScrollProgress({
  target,
  offset = ['start end', 'end start'],
}: ScrollProgressOptions): ScrollProgressResult {
  const { scrollYProgress } = useScroll({
    target,
    offset: offset as ['start end', 'end start'],
  });

  const progress = useTransform(scrollYProgress, [0, 1], [0, 1]);

  return { progress };
}
