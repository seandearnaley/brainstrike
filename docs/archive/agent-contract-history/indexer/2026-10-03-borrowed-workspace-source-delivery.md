# Borrowed workspace source delivery

CI is disabled due to cost; validation must run locally.

The coherent source is `d680d30ea751aa31a00b27bf78bcdff0e4050573` plus mandatory
retirement correction `86a9cfe5c80f2ba584511670b7336f684c5ca461`, transplanted onto
integration `0c5a0168e03491b5f6f55c4516bd1fcb27bb1db1`. Production, source tests and
original source evidence remain exact reviewed blobs. Current live contracts
are preserved with the source's bounded additions, and the current lock adds
only the canonical-ingestion workspace dependencies.

The broader browser consumer check exposed a stale service fixture: it mocked
the UI tree module while the extracted scanner calls the filesystem tree
module. The unchanged integration baseline strict-scan case passed. Changing
only that mock specifier made all 90 service cases pass. The provider fixture
adds the filesystem mock and retains its UI tree/context mock because debug
and coverage consumers still use that export. Assertions and traversal stub
behavior are unchanged. The coverage-audit fixture remains byte-identical to
the integration baseline.

Eight browser consumer suites passed 313 cases, covering scan, native/web path
selection, import, service, coordinator, provider and coverage audit. A separate
run of the unchanged audit fixture passed all 39 cases. Public package builds,
42 watcher cases, 11 source/runtime cases, the strict desktop read-bound case
and one actual built Node child integration case also passed.
Scoped source, filesystem, app-shell and desktop type closure passed all 61
tasks, including 652 desktop test files and strict Effect diagnostics for 658
files with zero errors, warnings or messages. Formatting changed no files.

These checks qualify the shared source extraction. Actual desktop main and
utility attachment, hidden inference settlement, reset and closed-window
lifetime remain separate composition work.
