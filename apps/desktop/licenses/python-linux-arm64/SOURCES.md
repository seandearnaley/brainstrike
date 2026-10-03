# Linux arm64 CPython notices and sources

These license texts are copied byte-for-byte from `python/licenses/` in the
following official python-build-standalone artifact. `sha256.json` records the
text bytes. Preserve the complete upstream set when updating the pinned runtime.

- Release: [20260728](https://github.com/astral-sh/python-build-standalone/releases/tag/20260728)
- Full artifact: [cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-pgo+lto-full.tar.zst](https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14%2B20260728-aarch64-unknown-linux-gnu-pgo%2Blto-full.tar.zst)
- Full artifact SHA256: `a2de029d346e95b328241ebdfb261c25385ed83b37cbf0d7c4e25ca1ce432823`
- Upstream derivation input: `cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-install_only.tar.gz`
- Upstream derivation input SHA256: `7886fdc0c49062a1366bd2cd4f99cc899a648592e5da9a8de237110dd8a1a057`
- Build metadata: `python/PYTHON.json` in that full artifact
- [Pinned build scripts and patches](https://github.com/astral-sh/python-build-standalone/tree/20260728)
- [Pinned component source URLs, versions, checksums and license metadata](https://github.com/astral-sh/python-build-standalone/blob/20260728/pythonbuild/downloads.py)
- [CPython 3.13.14 source](https://www.python.org/ftp/python/3.13.14/Python-3.13.14.tar.xz)
- [Berkeley DB 6.0.19 source](https://ftp.osuosl.org/pub/blfs/conglomeration/db/db-6.0.19.tar.gz)
  SHA256: `2917c28f60903908c2ca4587ded1363b812c4e830a5326aaa77c9879d13ae18e`

The shipped runtime is the derived
`cpython-3.13.14+20260728-aarch64-unknown-linux-gnu-brainstrike-no-dbm-v1.tar.gz`.
Its separate SHA256 is
`87721ef255b6b91c3c202c9052e96f6a7e38add2befbe24ac085d9dcc5e01d61`
and its size is 89,918,175 bytes, pinned in `resources/python-runtime/manifest.json`.
`derive-python-runtime.mjs` removes exactly
`python/lib/python3.13/lib-dynload/_dbm.cpython-313-aarch64-linux-gnu.so`, preserves
all other file payloads and symlinks, normalizes tar metadata, and uses tar 7.5.22
with gzip level 9. The upstream archive is a build input, never a Linux packaged
resource. The complete upstream notice set is retained, including the notice
for the omitted component; retaining it does not imply that component ships.

The full build's metadata marks `_dbm` as an optional shared extension linked
statically to `libdb.a`, with `Sleepycat` and `LICENSE.bdb.txt`. Condition 3 of
that notice requires information on obtaining DB and accompanying software
source. Review the redistribution/source-availability obligations before a
production release; removing the identified component and retaining these notices
does not establish general legal clearance.

The runtime's install-only archive retains CPython's license at
`python/lib/python3.13/LICENSE.txt` and pip's per-component notices under
`python/lib/python3.13/site-packages/pip-26.1.2.dist-info/licenses/`. It omits the
full archive's top-level `python/licenses/`, which is why this separate copy is
shipped alongside the immutable runtime archive.

Compatibility: direct `_dbm` and `dbm.ndbm` imports are intentionally unavailable.
New default `dbm.open` stores, explicit `dbm.sqlite3` stores, and `shelve` are
covered by tests. Existing Berkeley DB/ndbm databases and third-party/user scripts
requiring that backend need a compatible external migration or different backend;
there is no automatic backend/data conversion or system-Python fallback.
