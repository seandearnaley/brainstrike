import type { ComposerPrimitive } from '@assistant-ui/react';
import type { ComponentProps } from 'react';

/**
 * The adapter type the library's trigger popover accepts. Derived from the
 * component's own props so we don't add a direct dependency on
 * `@assistant-ui/core` (where `Unstable_TriggerAdapter` lives) — the react
 * package only re-exports the components, not that type. `NonNullable` strips
 * the `| undefined` from the optional prop.
 *
 * Prior to @assistant-ui/react 0.12.26 this was derived from the
 * mention-specific `Unstable_MentionRoot`'s `adapter` prop
 * (`Unstable_MentionAdapter`); the library unified `@` mentions and `/` slash
 * commands under one generic `Unstable_TriggerPopover` (see
 * `composer-trigger-popover.tsx`), so both this file's mention adapter and
 * that file's slash-command adapter now share this same `TriggerAdapter` type.
 */
export type TriggerAdapter = NonNullable<
  ComponentProps<typeof ComposerPrimitive.Unstable_TriggerPopover>['adapter']
>;

/** A single trigger item as the popover renders it (id/type/label/...). */
type MentionTriggerItem = ReturnType<NonNullable<TriggerAdapter['search']>>[number];

/**
 * A workspace file projected into the composer's "@" mention picker. The
 * composer is presentational (`packages/ui`), so it never queries the file
 * index — the candidate files are PASSED IN as a prop (mirroring how
 * `slashCommands` is passed). The app (app-shell) loads matches from the PGlite
 * file index as the user types (async-via-state) and feeds them here.
 *
 * `id` is the directive identity `rootId::path` (see
 * `encodeFileMentionId` in `@brainstrike/assistant-contract`): when the user
 * selects this item, the library serializes it to `:file[label]{name=id}` and
 * inserts that directive into the message, which the desktop assistant server
 * parses back out to inject the file's content into context.
 */
export interface FileMention {
  /** Encoded identity `rootId::path` used as the directive id. */
  readonly id: string;
  /** Display label (the file's basename). */
  readonly label: string;
  /** Workspace-relative path, shown as secondary detail. */
  readonly path: string;
  /** The owning root's display name, shown as secondary detail. */
  readonly rootLabel: string;
}

/**
 * Build the library mention adapter from the passed file list.
 *
 * The adapter is SYNCHRONOUS by contract (the library calls `search()` during
 * render to populate the popover). So the async work — loading file matches for
 * the typed query — happens UPSTREAM in app-shell: `onQueryChange` is called
 * with the active mention query so app-shell can run its debounced DB query and
 * feed fresh `files` back as a new prop, which rebuilds this adapter.
 *
 * `search()` therefore does NOT re-filter (the DB query already did) — it returns
 * the provided rows verbatim and reports the query so the loader can advance.
 * The notify is deferred to a microtask so calling it from the library's render
 * pass never triggers a React state update during render.
 */
export function buildFileMentionAdapter(
  files: readonly FileMention[],
  onQueryChange: (query: string) => void
): TriggerAdapter {
  const items: MentionTriggerItem[] = files.map((file) => ({
    id: file.id,
    label: file.label,
    type: 'file',
  }));
  return {
    categories() {
      return [];
    },
    categoryItems() {
      return [];
    },
    search(query: string) {
      // Defer to a microtask: `search` runs inside the library's render-phase
      // memo, and `onQueryChange` updates app-shell state — never set state
      // during another component's render.
      queueMicrotask(() => onQueryChange(query));
      return items;
    },
  };
}
