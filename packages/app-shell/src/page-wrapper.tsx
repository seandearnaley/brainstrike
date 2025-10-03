import type { ReactNode } from 'react';

export interface PageWrapperProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function PageWrapper({ title, description, children, className = '' }: PageWrapperProps) {
  return (
    <div className={`container max-w-2xl mx-auto py-8 h-full overflow-y-auto ${className}`}>
      <h1 className="text-3xl font-bold mb-8">{title}</h1>
      {description && <p className="text-muted-foreground mb-6">{description}</p>}
      {children}
    </div>
  );
}
