import { Badge, cn } from '@brainstrike/ui';
import { getFolderColor } from '@brainstrike/utils';
import * as React from 'react';

type ExtensionBadgeSize = 'default' | 'compact';

interface ExtensionBadgeProps {
  extension: string;
  size?: ExtensionBadgeSize;
  className?: string;
}

const sizeStyles: Record<ExtensionBadgeSize, { badge: string; label: string }> = {
  default: {
    badge: 'max-w-[5rem] px-2 py-0.5',
    label: 'font-medium text-xs',
  },
  compact: {
    badge: 'max-w-[4rem] px-1.5 py-0 leading-tight',
    label: 'font-medium text-[9px]',
  },
};

export const ExtensionBadge = React.memo(
  ({ extension, size = 'default', className }: ExtensionBadgeProps) => {
    const colors = getFolderColor(extension);
    const styles = sizeStyles[size];

    return (
      <Badge
        className={cn(
          'dark:!bg-[var(--extension-badge-dark-bg)] dark:!text-[var(--extension-badge-dark-text)] inline-flex shrink-0 items-center truncate transition-colors',
          styles.badge,
          className
        )}
        style={
          {
            '--extension-badge-bg': colors.light.bg,
            '--extension-badge-text': colors.light.text,
            '--extension-badge-dark-bg': colors.dark.bg,
            '--extension-badge-dark-text': colors.dark.text,
            backgroundColor: 'var(--extension-badge-bg)',
            color: 'var(--extension-badge-text)',
          } as React.CSSProperties
        }
        title={extension}
        variant="secondary"
      >
        <span className={cn('truncate', styles.label)}>{extension}</span>
      </Badge>
    );
  }
);

ExtensionBadge.displayName = 'ExtensionBadge';
