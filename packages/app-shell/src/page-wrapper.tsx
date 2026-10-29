import type { ReactNode } from 'react';

export interface PageWrapperProps {
  children: ReactNode;
  className?: string;
  description?: string;
  title: string;
}

export function PageWrapper({ title, description, children, className = '' }: PageWrapperProps) {
  return (
    <div className={`container mx-auto h-full max-w-2xl overflow-y-auto py-8 ${className}`}>
      <h1 className="mb-8 text-3xl font-bold">{title}</h1>
      {description && <p className="text-muted-foreground mb-6">{description}</p>}
      {children}
    </div>
  );
}
