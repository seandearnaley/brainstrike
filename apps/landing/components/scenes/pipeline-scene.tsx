'use client';

import { type MotionValue, motion, useTransform } from 'motion/react';

const STAGES = ['FILE', 'CHUNK', 'EMBED', 'VECTOR'] as const;

function StageBadge({
  stage,
  index,
  scrollProgress,
}: {
  stage: string;
  index: number;
  scrollProgress: MotionValue<number>;
}) {
  const start = 0.11 + index * 0.03;
  const end = start + 0.03;
  const badgeOpacity = useTransform(scrollProgress, [0, start, end, 1], [0, 0, 1, 1]);
  const badgeScale = useTransform(scrollProgress, [start, end], [0.9, 1]);

  return (
    <motion.div
      className="border border-[var(--color-newsprint)] bg-[var(--color-void)] px-4 py-2 font-mono text-[var(--color-newsprint)] text-sm tracking-widest"
      style={{ opacity: badgeOpacity, scale: badgeScale }}
    >
      [{stage}]
    </motion.div>
  );
}

function JobDot({
  dotIndex,
  scrollProgress,
}: {
  dotIndex: number;
  scrollProgress: MotionValue<number>;
}) {
  const start = 0.16 + dotIndex * 0.02;
  const end = 0.24;
  const dotX = useTransform(scrollProgress, [start, end], ['0%', '100%']);
  const dotOpacity = useTransform(
    scrollProgress,
    [0, start, start + 0.01, end - 0.01, end, 1],
    [0, 0, 1, 1, 0, 0]
  );

  return (
    <motion.div
      className="absolute top-1/2 z-20 h-3 w-3 bg-[var(--color-amber)]"
      style={{
        left: dotX,
        opacity: dotOpacity,
        x: '-50%',
        y: '-50%',
      }}
    />
  );
}

export function PipelineScene({ scrollProgress }: { scrollProgress: MotionValue<number> }) {
  const pathLength = useTransform(scrollProgress, [0.1, 0.18], [1, 0]);
  const yExit = useTransform(scrollProgress, [0.26, 0.3], [0, -100]);
  const sceneOpacity = useTransform(
    scrollProgress,
    [0, 0.06, 0.1, 0.26, 0.3, 1],
    [0, 0, 1, 1, 0, 0]
  );
  const copyOpacity = useTransform(
    scrollProgress,
    [0, 0.16, 0.18, 0.26, 0.28, 1],
    [0, 0, 1, 1, 0, 0]
  );
  const copyY = useTransform(scrollProgress, [0.16, 0.18], [20, 0]);

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center"
      style={{ y: yExit, opacity: sceneOpacity }}
    >
      <div className="relative flex w-full max-w-4xl flex-col items-center px-8">
        <div className="relative mb-8 flex h-24 w-full items-center">
          <div className="absolute top-1/2 h-0.5 w-full -translate-y-1/2 bg-[var(--color-ghost)]" />

          <svg
            aria-hidden="true"
            className="absolute top-0 left-0 h-full w-full overflow-visible"
            preserveAspectRatio="none"
          >
            <motion.line
              pathLength="1"
              stroke="var(--color-newsprint)"
              strokeDasharray="1"
              strokeDashoffset={pathLength}
              strokeWidth="2"
              x1="0"
              x2="100%"
              y1="50%"
              y2="50%"
            />
          </svg>

          <div className="absolute z-10 flex w-full justify-between px-4">
            {STAGES.map((stage, i) => (
              <StageBadge index={i} key={stage} scrollProgress={scrollProgress} stage={stage} />
            ))}
          </div>

          {[0, 1, 2].map((dotIndex) => (
            <JobDot dotIndex={dotIndex} key={dotIndex} scrollProgress={scrollProgress} />
          ))}
        </div>

        <motion.p
          className="font-[family-name:var(--font-display)] text-[var(--color-muted)] text-xl uppercase tracking-[0.15em] md:text-2xl"
          style={{ opacity: copyOpacity, y: copyY }}
        >
          Your files. Chunked. Embedded. Indexed. Locally.
        </motion.p>
      </div>
    </motion.div>
  );
}
