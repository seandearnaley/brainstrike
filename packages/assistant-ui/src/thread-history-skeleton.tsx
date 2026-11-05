const LINE = 'bg-muted h-3 rounded motion-safe:animate-pulse';

/**
 * Placeholder messages while a thread's history is still loading, so an
 * opening thread never reads as an empty one. Decorative: the viewport that
 * holds it carries `aria-busy` for assistive technology.
 */
export function ThreadHistorySkeleton() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-4"
      data-testid="thread-history-skeleton"
    >
      <div className="bg-muted ml-auto h-9 w-2/5 rounded-2xl motion-safe:animate-pulse" />
      <div className="flex flex-col gap-2">
        <div className={`${LINE} w-11/12`} />
        <div className={`${LINE} w-4/5`} />
        <div className={`${LINE} w-3/5`} />
      </div>
      <div className="bg-muted ml-auto h-9 w-1/3 rounded-2xl motion-safe:animate-pulse" />
      <div className="flex flex-col gap-2">
        <div className={`${LINE} w-5/6`} />
        <div className={`${LINE} w-2/3`} />
      </div>
    </div>
  );
}
