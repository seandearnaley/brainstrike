import { useScrollReveal } from '../hooks/use-scroll-reveal';

interface SectionWrapperProps {
  children: React.ReactNode;
  id?: string;
  className?: string;
}

export function SectionWrapper({
  children,
  id,
  className = '',
}: SectionWrapperProps): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.05 });

  return (
    <section
      className={`relative overflow-hidden px-6 py-16 sm:py-20 md:py-28 lg:py-36 ${className}`}
      id={id}
      ref={ref}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(24px)',
        transition: 'opacity 0.6s ease-out, transform 0.6s ease-out',
      }}
    >
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}
