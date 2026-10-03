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
