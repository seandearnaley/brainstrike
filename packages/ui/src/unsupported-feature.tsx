import type { ReactNode } from 'react';
import { cn } from './lib/utils';

export interface UnsupportedFeatureProps {
  /** The title to display */
  title: string;
  /** A descriptive message or ReactNode to explain the unsupported feature */
  description: ReactNode;
}

/**
 * A panel for displaying that a feature is not supported, with title and description.
 */
export function UnsupportedFeature({ title, description }: UnsupportedFeatureProps) {
  return (
    <div className={cn('p-8 max-w-2xl mx-auto')}>
      <h2 className="text-2xl font-bold mb-4">{title}</h2>
      <p className="mb-4">{description}</p>
    </div>
  );
}
