# Native Windows node-gyp header cache — evidence

Supports `docs/agents/ci-quality.md` § "Cost-ranked Linux x64 jobs run on
Ubicloud" — the node-gyp header cache rule (BST-1375, BST-1712). Read this
before changing the `native-windows` cache steps or when `Setup workspace`
fails there with a wall of `TAR_ENTRY_ERROR ENOENT`. The contract holds the
rules; this file is the record of why.

**node-gyp's HEADERS are the opposite case and ARE cached, for `native-windows`
only (BST-1375).** Compiled output is arch-specific and must never be shared;
the Node headers tarball is an input, and downloading it is what flaked. That
job installs two packages with native addons — `secure-fs-native` (implicit
`node-gyp rebuild` from `gypfile: true`) and `windows-job-native` (an explicit
install script that shells out to node-gyp on win32) — and pnpm runs workspace
install scripts CONCURRENTLY, so a cold `pnpm install` has both processes
fetching the same ~30MB `node-vX-headers.tar.gz` in the same second. Twice in
290 attempts one of those streams returned HTTP 200 and then had its body
aborted ~80s later (`TypeError: terminated`, undici `Fetch.onAborted`), failing
`Setup workspace` before anything compiled.

Read the log carefully if this recurs: the visible error is a wall of
`TAR_ENTRY_ERROR ENOENT` against a `node-gyp-tmp-*` path, which is downstream
NOISE — node-gyp's rollback deletes the temp dir while tar is still writing into
it. Two intuitive fixes are ruled out by measurement, not argument: the failing
path was 133 characters (a second occurrence died at ~62), so MAX_PATH and
Windows long-path settings are irrelevant; and node-gyp 13.0.1 extracts into
`os.tmpdir()` and copies to the dev dir afterwards, so a shorter
`npm_config_devdir` cannot move the path that failed. There is no prebuilt
path to pin — both addons are C++ sources built from this repo.

The wiring has five load-bearing parts, each of which silently un-does the fix
on its own, and `scripts/__tests__/native-windows-node-gyp-cache-contract.test.mjs`
pins them (with a mutation CONTROL per assertion):

1. the job pins `npm_config_devdir` — node-gyp's default lives under
   `%LOCALAPPDATA%` and no cache step can name it portably;
2. the restore runs **before** `Setup workspace`, because the download happens
   inside that composite's `pnpm install`. A restore after it prevents nothing;
3. the save key carries the Node version `setup-workspace` now exports as an
   output. `.nvmrc` pinned a MAJOR when this was written, so a key built from
   `.nvmrc` alone kept hitting after a patch bump, never re-saved, and quietly
   stopped covering the version in use. Restore is therefore prefix-keyed with
   `restore-keys` (corrected: `.nvmrc` now pins the exact `26.8.2`; the key
   shape is unchanged and the contract test still pins it);
4. the save is guarded on that output being non-empty. An entry written under
   the bare prefix EXACT-matches later restores and shadows the good
   version-keyed entry that `restore-keys` would have found;
5. the save is ALSO guarded on `steps.setup.outcome == 'success'` (BST-1712).
   A test or build failure leaves the setup outcome `success`, so the
   keep-the-cache-warm intent of `always()` survives, but a run whose setup
   itself failed never writes an entry.

A warm dev dir makes node-gyp's `--ensure` stat the dir, read `installVersion`,
re-check `<arch>/node.lib` on Windows, and report `version is good` with no HTTP
request at all. A COLD cache still downloads twice: the cache narrows the
window to roughly one run per Node patch bump, it does not make the fetch
robust. (Corrected: the cold path no longer keeps the original exposure —
BST-1712 made `native-windows` call `setup-workspace` with
`install-attempts: '3'`, guarded by
`scripts/__tests__/setup-workspace-install-retry-contract.test.mjs`, and added
part 5 above.) Serializing the two installs would also work,
but pnpm honours `--child-concurrency` only as a CLI flag (the
`npm_config_child_concurrency` env form is ignored — measured), and that would
mean parameterizing the shared composite's install command, which
`setup-workspace/action.yml`'s own header rules out.
