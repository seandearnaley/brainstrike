/**
 * Small presentational pieces shared by the drawer's three sections. Local to
 * this folder on purpose — the drawer must stay deletable in one PR, so none
 * of this leaks into shared modules.
 */

import { EMBEDDING_STATUS_CONFIG, type EmbeddingStatus } from '@brainstrike/ui';
import type { ReactNode } from 'react';

const STATUS_DOT_CLASS: Record<EmbeddingStatus, string> = {
  complete: 'bg-emerald-500',
  failed: 'bg-destructive',
  none: 'bg-muted-foreground/40',
  pending: 'bg-amber-500',
  processing: 'bg-sky-500',
};

/**
 * Status is never colour-only: the dot itself is decorative and the label
 * rides along as screen-reader text.
 *
 * Pass `decorative` when the row ALSO renders the status label visibly —
 * otherwise the row announces the same status twice.
 */
export function StatusDot({
  decorative = false,
  status,
}: {
  decorative?: boolean;
  status: EmbeddingStatus;
}) {
  return (
    <span className="flex shrink-0 items-center">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${STATUS_DOT_CLASS[status]}`}
        data-status={status}
      />
      {decorative ? null : <span className="sr-only">{EMBEDDING_STATUS_CONFIG[status].label}</span>}
    </span>
  );
}

export function DrawerSection({
  children,
  subtitle,
  testId,
  title,
}: {
  children: ReactNode;
  subtitle?: string;
  testId: string;
  title: string;
}) {
  return (
    <section className="border-t px-4 py-3 first:border-t-0" data-testid={testId}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="font-medium text-foreground text-xs">{title}</h3>
        {subtitle ? <span className="text-[10px] text-muted-foreground">{subtitle}</span> : null}
      </div>
      {children}
    </section>
  );
}
