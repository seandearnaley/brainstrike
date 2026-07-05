# Upstream issue draft → tursodatabase/turso

**Status: NOT FILED.** The repo owner has chosen not to file upstream issues from
automation. This draft is kept ready so a maintainer can file it (or adapt it)
directly. Repro assets: [`repro/wasm-indexed-insert-lockup/`](repro/wasm-indexed-insert-lockup/).

---

**Title:** WASM (browser): indexed `INSERT` inside a transaction hangs forever for
specific data-dependent payloads — statement promise never settles, no error
(native engine unaffected)

## Environment

- `@tursodatabase/database-wasm` **0.6.1** (stable) and **0.7.0-pre.17** — identical behavior
- Chromium (Playwright, headless), COOP/COEP static server, OPFS persistence, self-contained `/bundle` entry
- Contrast: native `@tursodatabase/database` **0.6.1** commits the identical statement stream in 4–7 ms (both WAL and MVCC / `BEGIN CONCURRENT`)

## Symptom

A plain `BEGIN` transaction inserting rows into a table with a PRIMARY KEY or a
secondary index hangs forever mid-statement for certain payloads: the statement
promise never resolves or rejects, and the connection is wedged for further
statements. `db.close()` still resolves — the engine is not CPU-spinning; the
statement's async completion appears to be lost.

## It is data-dependent, not size-dependent

Same content template, same schema, same statement stream, varying only content
size (bytes of text chunked into trigram rows):

| content bytes | result |
| --- | --- |
| 2500, 2800, 2850, 2950, 3400, 3600, 4K–16K, 32 KB, 1 MB | pass |
| **2900, 3000, 3100, 3200** | **hang (deterministic, reproduced 3+× each)** |

The 32 KB gram key set is a strict superset of the 3 000-byte set — larger writes
pass while smaller ones hang, so this is not volume. It tracks index-btree
page-state / key-distribution coincidences.

## Structural bisect (at a hanging payload)

- Table with **no PK and no secondary index → passes**
- **PK only → hangs**
- **Secondary index only (no PK) → hangs**

⇒ the lockup is in the WASM build's indexed-insert path.

## Ruled out

Parameter count (750-param inserts pass), statement count (10×250-row inserts in
one tx pass), `RETURNING`, foreign-key enforcement, multi-row vs single-row
statement shape, batch size (1/25/250 all hang). WAL checkpointing:
`PRAGMA wal_autocheckpoint` is not a valid pragma in the wasm build;
`PRAGMA wal_checkpoint(TRUNCATE)` executes but does not prevent the hang.

## Repro

A dependency-free parameterized HTML page + COOP/COEP server + Playwright driver
(`?bytes=`, `&noindex=1`, `&nopk=1`, `&batch=`, `&precheckpoint=`) plus a
native-engine contrast. See `repro/wasm-indexed-insert-lockup/`.

## Impact

Any browser application persisting realistic text with trigram/index sidecars
hits this on ordinary inputs. Because the failure is a silent never-settling
promise, applications cannot even fail gracefully without external timeouts.
