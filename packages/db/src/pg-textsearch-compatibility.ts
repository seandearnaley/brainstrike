/**
 * The only pg_textsearch engine version qualified for Brainstrike's local
 * PGlite runtime. Version 1.3.x introduced the persisted paged-memtable design
 * implicated in the corruption quarantined by migration 065.
 */
export const QUALIFIED_PG_TEXTSEARCH_VERSION = '1.2.0';
