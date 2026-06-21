import { Description as DialogDescription, Title as DialogTitle } from '@radix-ui/react-dialog';
import { Command as Cmdk } from 'cmdk';
import { FileIcon } from 'lucide-react';
import * as React from 'react';
import { cn } from '../lib/utils';

/**
 * One file row the quick-open palette renders. `id` is `file_records.id` (stable
 * cmdk value); `compositeKey` is the `${rootId}|@|${path}` argument the open
 * seam expects (built by the app from `root_id + path`, so identical paths in
 * two roots open the correct root). `rootLabel` is the root's display name, or a
 * neutral honest fallback for legacy unattributed rows.
 */
export interface QuickOpenFileItem {
  readonly compositeKey: string;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly rootLabel: string;
}

export interface QuickOpenPaletteProps {
  /** The rows the live query returned for the current query. */
  readonly files: readonly QuickOpenFileItem[];
  /** True while the live query is resolving the first page. */
  readonly loading?: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  /** Invoked with the chosen file's compositeKey when a row is selected. */
  readonly onSelect: (file: QuickOpenFileItem) => void;
  readonly open: boolean;
  /** The current search query (controlled — the SQL filters, not the palette). */
  readonly query: string;
}

/**
 * The ⌘P quick-open file finder: a presentational cmdk dialog over file rows the
 * app supplies from the PGlite index. It does NOT filter locally
 * (`shouldFilter={false}`) — the SQL `ILIKE` is the filter and the parent drives
 * the live query from `query`. Selection hands the row's `compositeKey` to the
 * app's `onSelect`, which opens it via the file-open seam.
 *
 * a11y mirrors the command palette: cmdk renders a Radix Dialog (focus-trap +
 * Escape) with a listbox/option structure and a screen-reader description.
 */
export function QuickOpenPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  files,
  loading = false,
  onSelect,
}: QuickOpenPaletteProps): React.ReactElement {
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset the query on close so the next open starts clean.
        onQueryChange('');
      }
      onOpenChange(next);
    },
    [onOpenChange, onQueryChange]
  );

  const handleSelect = React.useCallback(
    (file: QuickOpenFileItem) => {
      onSelect(file);
      handleOpenChange(false);
    },
    [onSelect, handleOpenChange]
  );

  return (
    <Cmdk.Dialog
      contentClassName={cn(
        'fixed top-[20%] left-1/2 z-[60] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
        'overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl'
      )}
      label="Quick open file"
      onOpenChange={handleOpenChange}
      open={open}
      overlayClassName="fixed inset-0 z-[59] bg-black/50"
      shouldFilter={false}
    >
      {/* Satisfy @radix-ui/react-dialog's unconditional Title/Description
          requirement (cmdk wraps the same Dialog instance) — visually hidden. */}
      <DialogTitle className="sr-only">Quick open file</DialogTitle>
      <DialogDescription className="sr-only">
        Search for a file by name and press Enter to open it.
      </DialogDescription>
      <div className="flex items-center border-b px-3" data-cmdk-input-wrapper="">
        <Cmdk.Input
          className={cn(
            'flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50'
          )}
          onValueChange={onQueryChange}
          placeholder="Go to file…"
          value={query}
        />
      </div>
      <Cmdk.List className="max-h-[320px] overflow-y-auto overflow-x-hidden p-1">
        <Cmdk.Empty className="py-6 text-center text-muted-foreground text-sm">
          {loading ? 'Searching…' : query ? 'No files found.' : 'Type to search files.'}
        </Cmdk.Empty>
        {files.map((file) => (
          <QuickOpenItem file={file} key={file.id} onSelect={handleSelect} />
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}

interface QuickOpenItemProps {
  readonly file: QuickOpenFileItem;
  readonly onSelect: (file: QuickOpenFileItem) => void;
}

function QuickOpenItem({ file, onSelect }: QuickOpenItemProps): React.ReactElement {
  return (
    <Cmdk.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none',
        'aria-selected:bg-accent aria-selected:text-accent-foreground'
      )}
      // Stable, unique value so cmdk keeps selection consistent across queries.
      onSelect={() => onSelect(file)}
      value={file.id}
    >
      <FileIcon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="shrink-0 truncate font-medium">{file.name}</span>
      <span className="flex-1 truncate text-muted-foreground text-xs">{file.path}</span>
      <span className="shrink-0 truncate text-muted-foreground text-xs">{file.rootLabel}</span>
    </Cmdk.Item>
  );
}
