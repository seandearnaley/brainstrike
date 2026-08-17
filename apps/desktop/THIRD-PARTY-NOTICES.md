# Third-Party Notices — BrainStrike Desktop

Hand-maintained notices for third-party components BUNDLED into the packaged
desktop app outside the npm dependency graph (npm dependencies carry their own
license metadata via their packages). Add an entry here whenever a build step
fetches or embeds an external component.

## CPython (via python-build-standalone)

- **Component:** CPython 3.13.14, `install_only` builds for
  `aarch64-apple-darwin` and `x86_64-apple-darwin`
- **Source:** python-build-standalone release `20260728`
  (<https://github.com/astral-sh/python-build-standalone>), maintained by
  Astral. Fetched checksum-pinned at build time by
  `scripts/fetch-python-runtime.mjs` against
  `resources/python-runtime/manifest.json` (BST-1061).
- **License:** Python Software Foundation License Version 2 (PSF-2.0),
  <https://docs.python.org/3/license.html>. python-build-standalone's own
  build scripts are BSD-3-Clause; only their build OUTPUT ships in the app.
- **Full license texts:** shipped inside the bundled archive itself and
  present in the unpacked runtime at `python/lib/python3.13/LICENSE.txt`,
  plus per-component licenses under `python/licenses/` in the
  python-build-standalone distribution. The archive links against libedit
  (BSD-style), not GNU readline, so no GPL component is bundled.
