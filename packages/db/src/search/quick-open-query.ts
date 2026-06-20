/**
 * Shared SQL for the ⌘P quick-open file finder (PR-6.3).
 *
 * One source of truth for the substring name search so the typed repository
 * method (`DrizzleFileRecordRepository.findByNamePrefix`) and the renderer's
 * reactive `usePGliteLiveQuery` execute the identical query. The trigram GIN
 * index `idx_file_records_name_trgm` (migration 048) makes the `name ILIKE`
 * filter an index scan.
 *
 * LEFT JOIN `roots` so legacy rows with a NULL `root_id` still return (their
 * `display_name` comes back NULL — the UI labels those "Workspace", an honest
 * fallback, never a guessed root name). Ordering by `length(name)` then `path`
 * surfaces the shortest (closest) name matches first, deterministically.
 */

/** Maximum rows quick-open ever returns, regardless of the requested limit. */
export const QUICK_OPEN_MAX_LIMIT = 50;

/**
 * The quick-open search query. `$1` = the substring query, `$2` = the bounded
 * limit. Selects `id` first so the live query can key incremental updates by it.
 */
export const QUICK_OPEN_NAME_SEARCH_SQL = `
  SELECT fr.id, fr.path, fr.name, fr.root_id, r.display_name
  FROM file_records fr
  LEFT JOIN roots r ON r.id = fr.root_id
  WHERE fr.name ILIKE '%' || $1 || '%'
  ORDER BY length(fr.name), fr.path
  LIMIT $2
`;

/** A single quick-open result row, as returned by the shared SQL. */
export interface QuickOpenFileRow {
  /** `roots.display_name`; NULL when the root is missing or `root_id` is NULL. */
  readonly display_name: string | null;
  /** `file_records.id`. */
  readonly id: string;
  /** File basename (the searchable display name). */
  readonly name: string;
  /** Path relative to the root. */
  readonly path: string;
  /** `file_records.root_id` (DB `roots.id`); NULL for legacy unattributed rows. */
  readonly root_id: string | null;
}

/**
 * Clamps an arbitrary requested limit to a safe positive bound so a caller can
 * never request an unbounded scan or a zero/negative limit.
 */
export function clampQuickOpenLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    return QUICK_OPEN_MAX_LIMIT;
  }
  return Math.min(Math.floor(requested), QUICK_OPEN_MAX_LIMIT);
}
