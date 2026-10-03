# Native canonical grep reader — 2026-10-03

The query utility owns exhaustive grep over explicit native root IDs and native
chunk identities. The PGlite service reexports the same extracted pure
createGrepLineMatcher; literal Unicode case folding, regex compilation and
unsafe-regex refusal retain existing semantics. No SQLite lower/instr
approximation or trigram substitution is used.

A missing grep method was the behavioral RED. The real engine control then
passes case-sensitive/Unicode literal, regex word-boundary, cross-root exclusion,
actual matched-chunk count and output-cap assertions. Four units,28 real-engine
cases and ordinary library/DB types pass. Existing grep service/pattern33tests
pass. Earlier guessed test filenames selected no tests and are not validation.
Actual Electron utility grep and unchanged hostile-query/lifecycle cases pass
with hashes preserved. Logs /private/tmp/query-native-grep-green.log,
query-native-grep-full-integration.log, query-native-grep-db-parity-v2.log and
query-native-grep-actual-utility.log.

The reader counts all matched chunks while retaining only the bounded ordered
output, enforces the process-message byte budget, and remains under the owned
process deadline. Main must validate live authorized roots before this provider
is exposed through the visible-UI IPC contract. Product fusion/metadata mapping
and running-app cutover remain separate consumer work; no M2 exit claim.

### Snapshot identity

Every native grep response carries canonical store ID and embedding state decoded from schema4 metadata in the same SQLite statement as its chunk rows. A LEFT JOIN retains identity for an empty requested scope; missing/corrupt/incompatible metadata refuses. The read-only authorizer and query result-limit guard remain unchanged. The protocol uses the canonical identity schema, and the shared row decoder validates all five metadata fields including the configured profile hash.

RED lacked identity; GREEN includes literal/regex/root/cap controls, empty-scope identity and incompatible metadata refusal. All28 engine cases plus actual Electron utility proof passed; the authoritative configured writer/WAL consumer proof validates exact identity and native chunk IDs before deadline kill, writer retention and reopen. Production provider/registration still requires live-root authorization and receipt-based full-scan readiness.

### Main capability adapter

The Node read capability reloads live canonical root IDs before acquisition and before returning results. It rejects empty/duplicate/disconnected scopes before opening the reader, validates native chunk source projections, closes the owned reader on every path, and retains both operation and cleanup causes. Grep preserves canonical path/chunk-ID ordering with no relevance score; it reports actual match count/truncation and scanLimited=false only after the exhaustive reader scan succeeds. Returned search identities must match the currently authoritative index owner. Root readiness comes from an injected producer receipt source, never row counts.

Guards: native-index-search.test.ts tests authorization before either acquisition, changed-store refusal and retained cleanup causes; the actual Electron WAL proof also exercises the capability over the same recorded native source/identity and chunk ID. Main registration/startup remains separate composition.
