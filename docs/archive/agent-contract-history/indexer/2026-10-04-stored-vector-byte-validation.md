# Stored Float32 byte validation

Support the canonical collection/profile contract by validating each stored
little-endian Float32 lane directly in the blob's actual byte span. Reject
invalid dimensions/length, any nonfinite lane and vectors containing only signed
zeros. Revalidate current storage on every existing integrity read.

The M2 diagnostic at
`/Users/seandearnaley/Documents/brainstrike-desktop-acceptance/m2-diagnostic-vector-1000-final-20261004T050558Z-3a2e258c/`
recorded 495 reader validations, 63.503 seconds of wall time and 60.338 sampled
seconds. `validateVectorBytes` accounted for 43.877 inclusive sampled seconds;
12.364 seconds in `vectorBlob` are nested within that total, not additive.

The previous path copied the blob, decoded a number array, then passed that array
through `vectorBlob`, allocating a Float32 array and an encoded Buffer that was
discarded. A bounded `DataView` reads the same values with explicit little-endian
decoding, including unaligned Buffer/Uint8Array subviews, without those copies.
The row decoder, surrounding read transaction, all storage validators and the
`rebuild-required` envelope retain their existing ownership. Authority revision
does not advance on every commit, so it cannot justify caching these checks.

The pure guard compares historical acceptance and exact errors for Float32
boundaries, subnormals, signed zero, NaN payloads, infinities and wrong lengths;
it also covers the recorded MiniLM vector and supported profile dimensions.
After correcting a Buffer-versus-Uint8Array test comparison, RED was 26 passes
and one allocation failure on the old implementation. Direct byte validation
passed all 27 tests. The native public guard mutates storage between coverage
reads and requires the exact corruption error before restoring valid bytes.
That native guard is source-ready but has not run in this source-only slot.

No end-to-end speedup is established by these tests. Native package validation,
normal commit hooks and any M2 rerun require the separately allocated heavy slot.
CI is disabled due to cost; validation must run locally.
