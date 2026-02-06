import { useEffect, useRef, useState } from 'react';

interface TypewriterTextProps {
  text: string;
  speed?: number;
  delay?: number;
  showCursor?: boolean;
  className?: string;
  onComplete?: () => void;
}

export function TypewriterText({
  text,
  speed = 50,
  delay = 0,
  showCursor = true,
  className = '',
  onComplete,
}: TypewriterTextProps): React.JSX.Element {
  const [displayText, setDisplayText] = useState('');
  const [isComplete, setIsComplete] = useState(false);
  const prefersReducedMotion = useRef(false);

  useEffect(() => {
    prefersReducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    if (prefersReducedMotion.current) {
      setDisplayText(text);
      setIsComplete(true);
      onComplete?.();
      return;
    }

    let charIndex = 0;
    let frameId: number;
    let lastTime = 0;

    const delayTimeout = setTimeout(() => {
      const animate = (timestamp: number): void => {
        if (!lastTime) {
          lastTime = timestamp;
        }

        if (timestamp - lastTime >= speed) {
          charIndex++;
          setDisplayText(text.slice(0, charIndex));
          lastTime = timestamp;

          if (charIndex >= text.length) {
            setIsComplete(true);
            onComplete?.();
            return;
          }
        }

        frameId = requestAnimationFrame(animate);
      };

      frameId = requestAnimationFrame(animate);
    }, delay);

    return () => {
      clearTimeout(delayTimeout);
      cancelAnimationFrame(frameId);
    };
  }, [text, speed, delay, onComplete]);

  return (
    <span className={className}>
      {displayText}
      {showCursor && (
        <span
          aria-hidden="true"
          className="inline-block w-[0.6em] translate-y-[1px] border-b-2"
          style={{
            borderColor: 'var(--accent)',
            animation: isComplete ? 'cursor-blink 1s step-end infinite' : 'none',
            opacity: isComplete ? undefined : 1,
          }}
        >
          &nbsp;
        </span>
      )}
    </span>
  );
}
