# Repro: `@tursodatabase/database-wasm` indexed-insert lockup

Self-contained reproduction of the vendor defect that blocks browser-Turso
chunk indexing (see
[`../../2026-07-05-remaining-issues-and-handoff.md`](../../2026-07-05-remaining-issues-and-handoff.md)).

**One-line symptom:** inside a transaction, an `INSERT` into a table with a
PRIMARY KEY or secondary index hangs **mid-statement with no error** for certain
data-dependent payloads. The statement promise never settles and the connection
wedges — but `db.close()` still resolves, so the engine is not CPU-spinning; the
statement's async completion is *lost*. The native (`@tursodatabase/database`)
engine commits the identical statement stream in milliseconds.

## What it does

`index.html` mirrors the exact `packages/db` `TursoFileChunkRepository.insertMany`
transaction shape — `BEGIN`; wide `file_chunks` row with `RETURNING`; delete +
re-insert of `file_chunk_content_index` and `file_chunk_content_grams` sidecars
(trigram widths 1–3, case-sensitive + insensitive, batched 250×3 params);
`COMMIT` — parameterized by content size. `serve.mjs` serves it plus the
**published vendor bundle** under cross-origin-isolation headers (no Vite, no dep
optimizer, no alias — the raw bundle as shipped). `sweep.mjs` drives it in
headless Chromium and prints one JSON verdict per size.

## Run it

```bash
# from this directory, with repo deps installed (pnpm install at the repo root)
node sweep.mjs            # canonical pass/hang matrix (a few minutes: each hang waits out a 30s tx timeout)
node sweep.mjs one 3000   # a single hanging size
node sweep.mjs one 2500   # a single passing control
node sweep.mjs bisect     # fine sweep across the cliff
```

If Chromium is missing: `pnpm --filter @brainstrike/web exec playwright install chromium`.

## Reading a verdict

```jsonc
// PASS — committed in single-digit ms:
{"bytes":2500,"tx":"committed","txMs":25,"gramBatchesDone":4,"close":"ok"}
// HANG — the lockup: tx never settled (tx-level 30s timeout fired mid gram batch),
// but the engine still closed cleanly => lost statement completion, not a spin:
{"bytes":3000,"tx":"ERROR: TIMEOUT: tx bytes=3000","txMs":30001,"gramBatchesDone":2,"close":"ok"}
```

## Confirmed matrix (0.6.1 and 0.7.0-pre.17, deterministic, reproduced 3+×)

| content bytes | result |
| --- | --- |
| 2500, 2800, 2850, 2950, 3400, 3600, 4K–16K, 32K, 1MB | **pass** |
| 2900, 3000, 3100, 3200 | **hang** |

It is **not** a size/volume threshold: the 32 KB gram key set is a strict
superset of the 3 000-byte set, yet 32 KB passes while 3 000 hangs. The trigger
is a page-state / key-distribution coincidence in the index btree insert path.

## Query params on `index.html` (for isolating the cause)

- `?bytes=N` — content size (default 3100)
- `&noindex=1` — drop the secondary index on the grams table → **passes** (localizes to the indexed path)
- `&nopk=1` — drop the grams PK → with `noindex` too, **passes**; either PK **or** index alone → **hangs**
- `&batch=N` — gram insert batch size (1/25/250 all hang — not statement shape)
- `&timeout=Ms` — per-transaction timeout (default 30000)
- `&autocheckpoint=N` / `&precheckpoint=truncate|full|passive` — WAL-checkpoint probes (no effect; `wal_autocheckpoint` is not even a valid pragma in the wasm build)

## Testing a different vendor version

```bash
npm pack @tursodatabase/database-wasm@<version>   # in a scratch dir
tar -xf tursodatabase-database-wasm-<version>.tgz
TURSO_BUNDLE_DIR=/abs/path/to/package/bundle node sweep.mjs one 3000
```

## Structural bisect result (already established)

- grams table with **no PK and no index → passes**
- **PK only → hangs**; **secondary index only → hangs**

⇒ the lockup is in the WASM build's **indexed-insert** path. The desktop app is
unaffected because it uses the native engine (`@tursodatabase/database`).
