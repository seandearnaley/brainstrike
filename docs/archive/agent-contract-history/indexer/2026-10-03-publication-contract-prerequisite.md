# Canonical publication prerequisite

The shared public mapper preserves canonical source/chunks/graph and accepts no
fabricated scope. Its emitted public entry must load in plain Node.

The integration delivery of the utility coordinator exposed missing package
prerequisites on `961fbb20260dddb71dbbbb30143686cf67afe8ad`. This focused extraction
retains seven source/manifest files from `fcea6be3559d01c5d7c6083a870f28bc02b4f8b9`:
the producer DTO and its export, canonical event module, symbol mapper,
publication mapper and its existing exports, plus the original worker-port
re-export of the extracted symbol mapper so there is one graph mapping authority.
The event/symbol modules originated
in `95408a787`, the DTO/publication export in `1c2379485`, and the rootless payload
with Node-compatible relative imports in `fcea6be3`.

No desktop producer, preload, writer manifest implementation, scan receipts or
browser import behavior is changed. The manifest implementation in `ded4d554d`
is not a dependency of this pure package boundary. The coordinator and its
mandatory physical-retirement correction remain a separate delivery.

RED on unchanged integration: the source mapper suite could not resolve the
missing module; the real plain-Node test failed `ERR_PACKAGE_PATH_NOT_EXPORTED`.
Both logs are preserved under `/tmp/m2-canonical-publication-*-red.log`.

GREEN: eight source mapper cases and fifteen existing worker-port cases passed;
the plain-Node public artifact case passed with the recorded two chunks and three
references. The declared build closure passed all 22 tasks, with 14 cached. The
package Turbo graph retains the inherited task dependencies, hashes the external
recording for deterministic test/coverage tasks, and requires the package build
before integration and full-suite coverage, both of which run the public artifact
case. Four existing real PGlite symbol-persistence cases also passed through the
original worker-port re-export.

CI is disabled due to cost; validation must run locally. These checks do not
establish connected Electron ingestion or whole-M2 acceptance.
