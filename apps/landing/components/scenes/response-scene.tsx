'use client';

import { type MotionValue, motion, useTransform } from 'motion/react';

const FILES = [
  'src/db/schema.ts',
  'src/pipeline/index.ts',
  'src/utils/text.ts',
  'src/workers/embed.ts',
  'docs/architecture.md',
] as const;

function FileTreeRow({
  file,
  index,
  highlightIndex,
}: {
  file: string;
  index: number;
  highlightIndex: MotionValue<number>;
}) {
  const isHighlighted = useTransform(highlightIndex, (idx) => index <= idx && index > idx - 1.5);
  const bgColor = useTransform(isHighlighted, (h) => (h ? 'var(--color-amber)' : 'transparent'));
  const textColor = useTransform(isHighlighted, (h) =>
    h ? 'var(--color-void)' : 'var(--color-newsprint)'
  );

  return (
    <motion.div
      className="-ml-2 px-2 py-1.5 font-mono text-xs sm:text-sm"
      style={{ backgroundColor: bgColor, color: textColor }}
    >
      {file}
    </motion.div>
  );
}

export function ResponseScene({ scrollProgress }: { scrollProgress: MotionValue<number> }) {
  const sceneOpacity = useTransform(
    scrollProgress,
    [0, 0.5, 0.54, 0.68, 0.72, 1],
    [0, 0, 1, 1, 0, 0]
  );
  const leftX = useTransform(scrollProgress, [0.54, 0.58], ['-40px', '0px']);
  const rightX = useTransform(scrollProgress, [0.54, 0.58], ['40px', '0px']);
  const leftOpacity = useTransform(scrollProgress, [0, 0.54, 0.58, 1], [0, 0, 1, 1]);
  const rightOpacity = useTransform(scrollProgress, [0, 0.54, 0.58, 1], [0, 0, 1, 1]);

  const fullText =
    'The embedding queue is processed by the Worker instance defined in src/workers/embed.ts. It pulls jobs from Redis and passes them to the chunkFile() utility before sending to OpenAI.';
  const charCount = useTransform(scrollProgress, [0.58, 0.66], [0, fullText.length]);
  const streamedText = useTransform(charCount, (c) => fullText.slice(0, Math.floor(c)));
  const streamCursorOpacity = useTransform(scrollProgress, [0.57, 0.58, 0.66, 0.67], [0, 1, 1, 0]);

  const badge1Scale = useTransform(scrollProgress, [0, 0.62, 0.63, 1], [0, 0, 1, 1]);
  const badge2Scale = useTransform(scrollProgress, [0, 0.64, 0.65, 1], [0, 0, 1, 1]);
  const highlightIndex = useTransform(scrollProgress, [0.66, 0.7], [-1, 5]);

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center px-8"
      style={{ opacity: sceneOpacity }}
    >
      <div className="@container grid w-full max-w-6xl grid-cols-1 gap-8 md:grid-cols-[280px_1fr]">
        <motion.div
          className="flex flex-col gap-0.5 border-[var(--color-muted)] border-l-2 pl-4"
          style={{ x: leftX, opacity: leftOpacity }}
        >
          <div className="mb-4 font-mono text-[10px] text-[var(--color-muted)] uppercase tracking-[0.2em] sm:text-xs">
            Workspace
          </div>
          {FILES.map((file, i) => (
            <FileTreeRow file={file} highlightIndex={highlightIndex} index={i} key={file} />
          ))}
        </motion.div>

        <motion.div
          className="flex max-w-2xl flex-col"
          style={{ x: rightX, opacity: rightOpacity }}
        >
          <div className="mb-4 font-mono text-[10px] text-[var(--color-amber)] uppercase tracking-[0.2em] sm:text-xs">
            BrainStrike Agent
          </div>

          <div className="font-[family-name:var(--font-mono)] text-[var(--color-newsprint)] text-sm leading-relaxed md:text-base">
            <motion.span>{streamedText}</motion.span>
            <motion.span
              className="ml-0.5 inline-block h-[1.1em] w-2 animate-cursor-blink bg-[var(--color-amber)] align-middle"
              style={{ opacity: streamCursorOpacity }}
            />

            <div className="mt-4 flex flex-wrap gap-2">
              <motion.span
                className="inline-flex items-center border border-[var(--color-muted)] bg-[var(--color-void)] px-2.5 py-1 font-mono text-[var(--color-muted)] text-xs"
                style={{ scale: badge1Scale }}
              >
                [reading: pipeline/index.ts]
              </motion.span>

              <motion.span
                className="inline-flex items-center border border-[var(--color-muted)] bg-[var(--color-void)] px-2.5 py-1 font-mono text-[var(--color-muted)] text-xs"
                style={{ scale: badge2Scale }}
              >
                [reading: queue/job-queue.ts]
              </motion.span>
            </div>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
