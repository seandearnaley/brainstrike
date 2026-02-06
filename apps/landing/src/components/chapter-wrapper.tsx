import { motion } from 'motion/react';

interface ChapterWrapperProps {
  children: React.ReactNode;
  id?: string;
  chapter?: string;
  className?: string;
}

export function ChapterWrapper({
  children,
  id,
  chapter,
  className = '',
}: ChapterWrapperProps): React.JSX.Element {
  return (
    <motion.section
      className={`relative overflow-hidden px-6 py-24 sm:py-32 md:py-40 ${className}`}
      id={id}
      initial={{ opacity: 0, y: 32 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      viewport={{ once: true, margin: '-60px' }}
      whileInView={{ opacity: 1, y: 0 }}
    >
      <div className="mx-auto max-w-6xl">
        {chapter && (
          <p
            className="mb-8 font-medium text-xs tracking-widest sm:mb-10 sm:text-sm"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
          >
            {chapter}
          </p>
        )}
        {children}
      </div>
    </motion.section>
  );
}
