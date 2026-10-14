# Python manifest Schema boundary — evidence

Supports `docs/agents/effect-boundary.md` § "Schema at boundaries". The main-process
Python runtime resolver decodes `manifest.json` once after JSON parsing and before
any archive or unpack work. It derives both exported manifest types from the
Schema. The boundary maps the first issue path to the existing
`PythonManifestInvalidError` messages; it does not expose Schema's parser text
to callers. Missing target membership or an absent entry in an otherwise valid
manifest remains `PythonUnsupportedPlatformError` after decoding.

BST-1831, 2026-09-25. The previous hand validator treated an array root as
an object and reported a missing string field instead of a root-shape error.
It accepted an array `targets` map, then reported unsupported platform.
Focused RED tests reproduced both classifications. Schema rejects both shapes.
It retains required-string priority (`assetUrlTemplate`, `pythonVersion`,
`releaseTag`, `variant`) before list/map errors, validates every target entry,
requires lowercase 64-character SHA-256, and uses `Schema.Int` for positive
safe-integer byte counts. Existing read and JSON parse errors stay outside this
decoder. No release URL, archive, unpack, or factory-reset policy changed.

The desktop main bundle changed from 2,704,577 to 2,705,065 bytes raw and
from 576,122 to 576,297 bytes gzip (+488 raw / +175 gzip). A temporary Vitest benchmark
called `resolvePythonBinary` 1,000 times through file read, JSON parse, and the
invalid `variant` path after 100 warmups. Baseline samples were 29.797 and
29.529 ms; candidate samples were 36.467 and 35.180 ms. This is a local
comparison, not an end-user startup measurement. The benchmark file was
removed before commit.

Guard: `scripts/__tests__/effect-boundary-contract.test.mjs` pins the Schema
decode, derived types, domain error adapter, and removal of the hand
validator. Resolver tests pin exact messages, malformed collection shapes,
multi-invalid priority, all-entry validation, safe integers, missing target
policy, and existing install/reset behavior. The real-archive integration test
also passed after the pinned archives were fetched: it verified checksum,
unpacked CPython, ran `print(1+1)`, and reused the sentinel install.
