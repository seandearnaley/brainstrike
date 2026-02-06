import { useCallback, useRef } from 'react';
import { useScrollReveal } from '../hooks/use-scroll-reveal';

interface AnimatedCounterProps {
  end: number;
  duration?: number;
  suffix?: string;
  prefix?: string;
}

export function AnimatedCounter({
  end,
  duration = 2000,
  suffix = '',
  prefix = '',
}: AnimatedCounterProps): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.5 });
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const hasAnimated = useRef(false);

  const setRef = useCallback(
    (node: HTMLSpanElement | null) => {
      spanRef.current = node;
      (ref as React.RefObject<HTMLSpanElement | null>).current = node;
    },
    [ref]
  );

  // Drive animation via requestAnimationFrame, updating DOM directly
  if (isVisible && !hasAnimated.current) {
    hasAnimated.current = true;
    let startTime: number | null = null;

    const animate = (timestamp: number): void => {
      if (!startTime) {
        startTime = timestamp;
      }
      const progress = Math.min((timestamp - startTime) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      const current = Math.floor(eased * end);

      if (spanRef.current) {
        spanRef.current.textContent = `${prefix}${current}${suffix}`;
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }

  return (
    <span className="tabular-nums" ref={setRef} style={{ fontFamily: 'var(--font-heading)' }}>
      {prefix}
      {0}
      {suffix}
    </span>
  );
}
