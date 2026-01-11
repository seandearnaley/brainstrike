import type { ReactNode } from 'react';

export interface PageWrapperProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

export function PageWrapper({ title, description, children, className = '' }: PageWrapperProps) {
  return (
    <div className={`container mx-auto h-full max-w-2xl overflow-y-auto py-8 ${className}`}>
      <h1 className="mb-8 font-bold text-3xl">{title}</h1>
      {description && <p className="mb-6 text-muted-foreground">{description}</p>}
      {children}
    </div>
  );
}
