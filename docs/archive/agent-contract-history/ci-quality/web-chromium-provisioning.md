# Web Chromium provisioning

Use an explicit versioned CfT executable while retaining the Playwright engine fleet.

BST-1964 reproduced an incognito OPFS handle crash at the first IndexedDB get
following a cold reload on CfT 153.0.8010.12. Chromium's
[fix](https://github.com/chromium/chromium/commit/909a0222ba0f48ace3fd3a011b379dcd998871bb)
adds the missing in-memory FSA reference lookup. The exact
[CfT 154.0.8037.57 metadata](https://googlechromelabs.github.io/chrome-for-testing/154.0.8037.57.json)
and tagged source contain this fix. This is a candidate: Playwright documents
[no compatibility guarantee for other executables](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path).

Explicit local provisioning (not a test startup side effect):

```sh
node scripts/provision-web-chromium.mjs /absolute/browser-root
export BRAINSTRIKE_WEB_CHROMIUM_DIR=/absolute/browser-root
```

The installer checks ZIP integrity, verifies the executable, and emits observed
archive/binary SHA-256 hashes and verifies `--version` before publishing the installation. Extraction is staged;
an existing destination fails instead of being reused or overwritten. A failed
run leaves its empty destination and staging files for inspection.

The smoke, full regression, and performance jobs retain the digest-pinned official
MCR 1.63.0 image and its Firefox/WebKit binaries. Each sets up Node from `.nvmrc`,
installs `unzip`, `lsof`, and `procps`, then explicitly provisions CfT into a fresh
`runner.temp` directory. The provisioning JSON lives with test results. This uses
Playwright's [documented root mode for trusted E2E](https://playwright.dev/docs/docker)
so job setup can install system tools; no user-managed registry or custom-image
publication gate is needed. The draft publication requirement is superseded by
these locally verified job steps, not by an unpublished image ID.

Qualification remains the unchanged native cold-roundtrip probe on exact .57
on macOS and Linux, then ten persistence cases executed with zero skips in three
complete runs, then full regression. The native failure stops app retries.
The existing quarantine remains until those gates pass. A beforeAll attachment
records the actual Chromium version for the persistence lane.

CI is disabled due to cost; validation must run locally.
