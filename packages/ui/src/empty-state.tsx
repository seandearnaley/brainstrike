import * as React from 'react';
import { cn } from './lib/utils';

interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  action?: React.ReactNode;
  description?: string;
  icon?: React.ReactNode;
  title: string;
}

/**
 * A premium empty state component following 2026 UI/UX standards.
 * Features an opaque, unique gradient background per theme to avoid visual monotony.
 */
export function EmptyState({
  action,
  className,
  description,
  icon,
  style,
  title,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center px-8 text-center',
        // Shared panel surface gradient (see --panel-surface / .bg-panel-surface)
        'bg-panel-surface',
        className
      )}
      style={style}
      {...props}
    >
      <div className="flex max-w-[320px] flex-col items-center gap-8">
        {icon && (
          <div className="relative">
            {/* Soft ambient glow */}
            <div className="absolute inset-0 rounded-full bg-primary/10 blur-2xl" />
            {/* Minimalist circular background with alt shade */}
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-muted/40 transition-colors duration-500">
              {React.isValidElement(icon)
                ? React.cloneElement(
                    icon as React.ReactElement<React.HTMLAttributes<HTMLElement>>,
                    {
                      className: cn(
                        'h-9 w-9 text-muted-foreground/80',
                        (icon.props as React.HTMLAttributes<HTMLElement>).className
                      ),
                    }
                  )
                : icon}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <h3 className="font-semibold text-foreground text-lg tracking-tight">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
          )}
        </div>

        {action && <div className="pt-1">{action}</div>}

        {/* Minimalist 2026 Grid Identity Element */}
        <div className="grid grid-cols-3 gap-1.5 pt-4 opacity-15">
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
          <div className="h-1 w-1 rounded-full bg-foreground" />
        </div>
      </div>
    </div>
  );
}
