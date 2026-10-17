/**
 * The pg_textsearch engine bundled by the qualified PGlite 0.5.10 family.
 * BST-2032 qualifies fresh 1.5.1 stores through the existing durability gate:
 * insert/update/delete, actual BM25 index reads, VACUUM and populated reopen.
 * The current-schema catalog independently pins extension and function grants.
 *
 * Qualification is for fresh data and same-schema reopen. It does not promise
 * compatibility with index pages from earlier development binaries or create
 * a legacy-data migration. Keep extension changes coupled to the PGlite family
 * and rerun these guards before changing this version again.
 */
export const QUALIFIED_PG_TEXTSEARCH_VERSION = '1.5.1';
