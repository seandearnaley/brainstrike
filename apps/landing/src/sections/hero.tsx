import { ArrowRight } from 'lucide-react';
import type { Variants } from 'motion/react';
import { motion } from 'motion/react';
import { GitHubIcon } from '../components/github-icon';
import { ProductMockup } from '../components/product-mockup';
import { TypewriterText } from '../components/typewriter-text';

const stagger: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.15, duration: 0.5, ease: 'easeOut' as const },
  }),
};

export function Hero(): React.JSX.Element {
  return (
    <section className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6 pt-24 pb-16">
      <div className="relative z-10 mx-auto max-w-5xl text-center">
        {/* Headline */}
        <motion.h1
          className="mb-4 font-bold text-4xl leading-[0.95] tracking-tight sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl"
          custom={0}
          initial="hidden"
          variants={stagger}
          viewport={{ once: true }}
          whileInView="visible"
        >
          YOUR KNOWLEDGE.
          <br />
          <span className="accent-text">VECTORIZED.</span>
        </motion.h1>

        {/* Terminal command */}
        <motion.div
          className="mb-8 sm:mb-10"
          custom={1}
          initial="hidden"
          variants={stagger}
          viewport={{ once: true }}
          whileInView="visible"
        >
          <p
            className="text-sm sm:text-base"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
          >
            <span className="accent-text">$</span>{' '}
            <TypewriterText
              delay={800}
              speed={40}
              text="brainstrike --local --zero-backend --ai-powered"
            />
          </p>
        </motion.div>

        {/* CTAs */}
        <motion.div
          className="mb-16 flex flex-col items-center justify-center gap-3 sm:mb-20 sm:flex-row sm:gap-4"
          custom={2}
          initial="hidden"
          variants={stagger}
          viewport={{ once: true }}
          whileInView="visible"
        >
          <a
            className="group inline-flex items-center gap-2 rounded-lg px-6 py-3 font-medium text-sm transition-all duration-200 hover:brightness-110"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              background: 'var(--accent)',
              color: 'white',
            }}
            target="_blank"
          >
            Try BrainStrike
            <ArrowRight
              className="transition-transform duration-200 group-hover:translate-x-0.5"
              size={16}
            />
          </a>
          <a
            className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 font-medium text-sm transition-colors duration-200 hover:text-white"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              borderColor: 'var(--border-hover)',
              color: 'var(--text-secondary)',
            }}
            target="_blank"
          >
            <GitHubIcon size={16} />
            View Source
          </a>
        </motion.div>

        {/* Product mockup */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          style={{
            transform: 'perspective(1200px) rotateX(2deg)',
          }}
          transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          <ProductMockup />
        </motion.div>
      </div>
    </section>
  );
}
