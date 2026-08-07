import { Folder } from 'lucide-react';
import type { ReactElement } from 'react';

/**
 * The assistant's operating root, as shown to the user near the composer.
 * Threaded from app-shell (the ui package stays store-free): the wrapper
 * passes it ONLY when 2+ workspace roots are mounted, so single-root
 * workspaces render zero extra chrome.
 */
export interface OperatingRootInfo {
  /** Display name of the MAIN root (activeRootIds[0]). */
  readonly displayName: string;
  /** Absolute path (desktop); absent for web FSA roots. */
  readonly path?: string | undefined;
}

/**
 * Compact muted chip at the top of the composer stack: "in {main root}".
 * Multi-root disambiguation only — reminds the user which folder the
 * assistant operates in (hooks cwd, file tools default) while they browse or
 * select in another root. Sibling of ThreadContextMeter in the
 * bs-composer-shell stack — deliberately NOT nested inside the meter (the
 * meter is being reworked separately).
 */
export const OperatingRootChip = ({
  operatingRoot,
}: {
  readonly operatingRoot?: OperatingRootInfo | undefined;
}): ReactElement | null => {
  if (!operatingRoot) {
    return null;
  }
  return (
    <div className="flex justify-start px-1 pb-1">
      <span
        className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
        data-testid="operating-root-chip"
        {...(operatingRoot.path ? { title: operatingRoot.path } : {})}
      >
        <Folder aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">in {operatingRoot.displayName}</span>
      </span>
    </div>
  );
};

OperatingRootChip.displayName = 'OperatingRootChip';
