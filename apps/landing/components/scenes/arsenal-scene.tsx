'use client';

import { type MotionValue, motion, useTransform } from 'motion/react';

function FeatureColumn({
  num,
  title,
  desc,
  yVal,
  opacityVal,
  scaleXVal,
}: {
  num: string;
  title: string;
  desc: string;
  yVal: MotionValue<number>;
  opacityVal: MotionValue<number>;
  scaleXVal: MotionValue<number>;
}) {
  return (
    <motion.div className="relative flex flex-col" style={{ y: yVal, opacity: opacityVal }}>
      <div className="pointer-events-none absolute -top-16 -left-4 select-none font-[family-name:var(--font-display)] text-[20vw] leading-none opacity-[0.06] md:text-[12vw]">
        {num}
      </div>
      <motion.hr
        className="mb-6 h-[2px] origin-left border-0 bg-[var(--color-amber)]"
        style={{ scaleX: scaleXVal }}
      />
      <h3 className="z-10 mb-4 font-[family-name:var(--font-display)] text-2xl uppercase tracking-[0.08em] md:text-3xl">
        {title}
      </h3>
      <p className="z-10 font-mono text-[var(--color-muted)] text-sm leading-relaxed md:text-base">
        {desc}
      </p>
    </motion.div>
  );
}

export function ArsenalScene({ scrollProgress }: { scrollProgress: MotionValue<number> }) {
  const col1Y = useTransform(scrollProgress, [0.72, 0.78], [50, 0]);
  const col1Opacity = useTransform(scrollProgress, [0, 0.72, 0.78, 1], [0, 0, 1, 1]);
  const col1ScaleX = useTransform(scrollProgress, [0.72, 0.78], [0, 1]);

  const col2Y = useTransform(scrollProgress, [0.78, 0.84], [50, 0]);
  const col2Opacity = useTransform(scrollProgress, [0, 0.78, 0.84, 1], [0, 0, 1, 1]);
  const col2ScaleX = useTransform(scrollProgress, [0.78, 0.84], [0, 1]);

  const col3Y = useTransform(scrollProgress, [0.84, 0.9], [50, 0]);
  const col3Opacity = useTransform(scrollProgress, [0, 0.84, 0.9, 1], [0, 0, 1, 1]);
  const col3ScaleX = useTransform(scrollProgress, [0.84, 0.9], [0, 1]);

  const ctaY = useTransform(scrollProgress, [0.88, 0.94], [60, 0]);
  const ctaOpacity = useTransform(scrollProgress, [0, 0.88, 0.94, 1], [0, 0, 1, 1]);

  const sceneOpacity = useTransform(scrollProgress, [0, 0.68, 0.72, 1], [0, 0, 1, 1]);
  const pointerEvents = useTransform(scrollProgress, (v) => (v > 0.7 ? 'auto' : 'none'));

  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col items-center justify-center px-8"
      style={{ pointerEvents, opacity: sceneOpacity }}
    >
      <div className="@container w-full max-w-6xl">
        <div className="mb-20 grid grid-cols-1 gap-12 md:grid-cols-3 md:gap-8 lg:gap-16">
          <FeatureColumn
            desc="Full semantic search over your codebase. PGlite + pgvector in WASM. Nothing leaves your machine."
            num="01"
            opacityVal={col1Opacity}
            scaleXVal={col1ScaleX}
            title="Local Vector Search"
            yVal={col1Y}
          />
          <FeatureColumn
            desc="Multi-provider. MCP-connected. Streams tokens in real time with tool use and memory."
            num="02"
            opacityVal={col2Opacity}
            scaleXVal={col2ScaleX}
            title="Streaming AI Agent"
            yVal={col2Y}
          />
          <FeatureColumn
            desc="File → Chunk → Embed → Vector. Background pipeline with live progress tracking."
            num="03"
            opacityVal={col3Opacity}
            scaleXVal={col3ScaleX}
            title="Indexed In Seconds"
            yVal={col3Y}
          />
        </div>

        <motion.div
          className="flex w-full flex-col items-center gap-6"
          style={{ y: ctaY, opacity: ctaOpacity }}
        >
          <button
            aria-label="Install BrainStrike Desktop App"
            className="group relative w-full max-w-2xl cursor-pointer border-2 border-[var(--color-amber)] bg-transparent px-8 py-6 text-center font-[family-name:var(--font-display)] text-[var(--color-newsprint)] text-xl uppercase tracking-[0.2em] transition-colors duration-75 hover:bg-[var(--color-amber)] hover:text-[var(--color-void)] md:text-3xl"
            type="button"
          >
            Install Desktop App →
          </button>
          <span className="font-mono text-[var(--color-muted)] text-xs uppercase tracking-widest">
            macOS · Linux · Windows
          </span>
        </motion.div>
      </div>
    </motion.div>
  );
}
