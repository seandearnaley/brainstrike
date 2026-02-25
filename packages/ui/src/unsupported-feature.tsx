import type { ReactNode } from 'react';
import { cn } from './lib/utils';

export interface UnsupportedFeatureProps {
  /** A descriptive message or ReactNode to explain the unsupported feature */
  description: ReactNode;
  /** The title to display */
  title: string;
}

/**
 * A panel for displaying that a feature is not supported, with title and description.
 */
export function UnsupportedFeature({ title, description }: UnsupportedFeatureProps) {
  return (
    <div className={cn('mx-auto max-w-2xl p-8')}>
      <h2 className="mb-4 font-bold text-2xl">{title}</h2>
      <p className="mb-4">{description}</p>
    </div>
  );
}
