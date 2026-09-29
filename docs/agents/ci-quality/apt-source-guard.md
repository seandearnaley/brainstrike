# apt source guard — evidence

Supports `docs/agents/ci-quality.md` § "Every Linux apt site drops the unused
Google Chrome source first" (BST-1715). Read this before touching any Linux
system-dependency step, the `apt-drop-unused-sources` action, or when an apt
step fails in CI. The contract holds the rules; this file is the incident and
the proof.

`apt-get update` exits non-zero when ANY configured repository's index fails
verification, even when every other repository updated fine (apt's own wording:
"They have been ignored, or old ones used instead"). Under `set -euo pipefail`
that is fatal. On 2026-09-09 Google's CDN served a `Release` manifest
inconsistent with `Packages.gz` on some edges — `Hash Sum mismatch` — and ten
checks on one PR died in system-dependency install steps without running a
single test, across four run attempts, each within ~20 seconds. Fetching the
same URL from outside CI returned HTTP 200 and a valid gzip, so which runner
failed depended on which edge it hit and reruns were a coin flip.

Every package those steps install comes from UBUNTU's archives —
`bubblewrap socat ripgrep`, `dbus-x11 gnome-keyring xdg-utils`, and the Chromium
system libraries `playwright install-deps` resolves. The repository that broke
belongs to Google, is added by the runner image, and NOTHING here installs from
it: every Playwright project pins `channel: 'chromium'` (Playwright's own build,
downloaded from its CDN), never `'chrome'` (the apt-installed Google Chrome).

`.github/actions/apt-drop-unused-sources` removes that source, and asserts the
result rather than trusting the filename pattern: if any configured source still
references `dl.google.com` after the removal it fails by name. It is used
immediately ahead of every apt site — the Unit lane's OS-fence deps (which run
BEFORE `Setup workspace`, so folding this into that composite would have left
the seven shards exposed), native-electron's desktop services, and the four
`playwright install-deps chromium` steps in test.yml and desktop-e2e.yml (two
each; corrected 2026-09-21 — this read "three" before the delegated smoke
job existed), plus local-desktop-e2e.yml's xvfb step.

It is NOT `apt-get update || true`, `-o APT::Update::Error-Mode`, or any other
relaxation of apt's exit status, and `apt-source-guard-contract.test.mjs`
forbids all of them: those would also swallow a genuine failure to reach
Ubuntu's archives and turn a clear provisioning error into a baffling install
error several steps later. Narrow the exposure; never widen the tolerance. The
same contract scans every workflow for apt steps rather than a list of today's
sites, so a NEW apt step added without the guard fails there.

A green run is not evidence here — the upstream inconsistency is intermittent by
edge. The guard was proven in `ubuntu:24.04` against a deliberately broken
third-party source (a locally served repo whose `Release` digest disagrees with
the `Packages.gz` it serves, reproducing `E: Failed to fetch ... Hash Sum
mismatch` / exit 100): provisioning fails with the source present and no guard,
succeeds with the guard, and STILL fails when the broken source is one the guard
does not drop. Reproduce it that way, not by rerunning CI. Note that apt does
not hash-verify `file:`/`copy:` transports and treats an unreachable host as a
warning — only a mismatch over HTTP reproduces the hard error.
