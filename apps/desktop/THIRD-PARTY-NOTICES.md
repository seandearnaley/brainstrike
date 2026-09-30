# Third-Party Notices — BrainStrike Desktop

Hand-maintained notices for third-party components BUNDLED into the packaged
desktop app outside the npm dependency graph (npm dependencies carry their own
license metadata via their packages). Add an entry here whenever a build step
fetches or embeds an external component.

## CPython (via python-build-standalone)

- **Component:** CPython 3.13.14, `install_only` builds for
  `aarch64-apple-darwin`, `x86_64-apple-darwin`, and
  `x86_64-unknown-linux-gnu` (Linux uses the derived `no-dbm-v1` archive)
- **Source:** python-build-standalone release `20260728`
  (<https://github.com/astral-sh/python-build-standalone>), maintained by
  Astral. Fetched checksum-pinned at build time by
  `scripts/fetch-python-runtime.mjs` against
  `resources/python-runtime/manifest.json` (BST-1061).
- **License:** Python Software Foundation License Version 2 (PSF-2.0),
  <https://docs.python.org/3/license.html>. python-build-standalone's own
  [build scripts](https://github.com/astral-sh/python-build-standalone/blob/20260728/LICENSE)
  are MPL-2.0; only their build output ships in the app.
- **Full license texts:** shipped inside the bundled archive itself and
  present in the unpacked runtime at `python/lib/python3.13/LICENSE.txt`,
  with pip's notices under its `site-packages/pip-*.dist-info/licenses/`.
  The `install_only` archives do **not** include the full distribution's
  `python/licenses/` directory. Linux packages additionally ship the upstream
  full-distribution notice set at `python-runtime/licenses/`, including
  `SOURCES.md` with source links and provenance. The build uses libedit, not
  GNU readline; this does not establish clearance for other components.
- **Linux variant:** the upstream `_dbm` extension is statically linked to
  Berkeley DB. The Linux-only `no-dbm-v1` derivation removes that extension
  from the shipped archive and records a separate checksum; the upstream input
  archive is not packaged. Its notices and source provenance are retained.
  Direct `_dbm` / `dbm.ndbm` imports are unavailable; default `dbm`,
  `dbm.sqlite3`, and `shelve` remain covered by compatibility tests. This
  component removal is not a general determination of redistribution clearance.
