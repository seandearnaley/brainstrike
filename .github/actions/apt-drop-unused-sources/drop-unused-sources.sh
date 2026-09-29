#!/usr/bin/env bash
#
# BST-1715: remove the GitHub runner image's Google Chrome apt source before
# anything on a Linux lane runs `apt-get update`.
#
# WHY. `apt-get update` exits non-zero when ANY configured repository's index
# fails verification, even when every other repository updated fine (apt's own
# wording: "They have been ignored, or old ones used instead"). Under
# `set -euo pipefail` that is fatal. On 2026-09-09 Google's CDN served a
# `Release` manifest inconsistent with `Packages.gz` on some edges:
#
#   E: Failed to fetch https://dl.google.com/linux/chrome-stable/deb/dists/stable/main/binary-amd64/Packages.gz
#      Hash Sum mismatch
#
# Ten checks on one PR died in system-dependency install steps, none of them
# having run a single test, across four run attempts — whether a runner failed
# depended on which CDN edge it hit, so reruns were a coin flip.
#
# WHY IT IS SAFE TO DROP. Every package these lanes install comes from
# UBUNTU's archives: `bubblewrap socat ripgrep`, `dbus-x11 gnome-keyring
# xdg-utils`, and the Chromium system libraries `playwright install-deps`
# resolves. Nothing in this repository installs `google-chrome-stable` or any
# other package from `dl.google.com`, and Playwright provisions its own browser
# binaries from its CDN rather than apt — every Playwright project in the repo
# pins `channel: 'chromium'` (Playwright's own build), never `'chrome'` (the
# apt-installed Google Chrome). The source is added by the runner image for
# image users who want Chrome; it is dead weight here.
#
# WHAT THIS DELIBERATELY IS NOT. It is not `apt-get update || true`, nor
# `-o APT::Update::Error-Mode=any`, nor any other relaxation of apt's exit
# status. Those would also swallow a genuine failure to reach Ubuntu's
# archives and turn a clear provisioning error into a baffling install error
# several steps later. This NARROWS the exposure (one unused source is no
# longer configured, so it can no longer fail) instead of WIDENING the
# tolerance. Callers keep `set -e` and keep failing loudly on a real problem.
set -euo pipefail

# Every source removed here must be one nothing in this repo installs from.
readonly UNUSED_SOURCE_HOST='dl.google.com'

if ! command -v apt-get >/dev/null 2>&1; then
  echo "drop-unused-sources: no apt-get on this host; this script is apt/Linux only" >&2
  exit 1
fi

# Runners execute as a passwordless-sudo non-root user; containers (and the
# Docker-based control test for this script) run as root, where sudo need not
# exist. This chooses the privilege escalation actually available, and does not
# choose whether the removal happens.
SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  SUDO=(sudo)
fi

removed=0
shopt -s nullglob
for source_file in \
  /etc/apt/sources.list.d/google-chrome*.list \
  /etc/apt/sources.list.d/google-chrome*.sources; do
  echo "drop-unused-sources: removing ${source_file}"
  "${SUDO[@]}" rm -f -- "${source_file}"
  removed=$((removed + 1))
done
shopt -u nullglob

if [ "${removed}" -eq 0 ]; then
  echo "drop-unused-sources: no Google Chrome apt source present; nothing to remove"
fi

# The removal above is filename-shaped, so assert the RESULT rather than trust
# the pattern: if any configured source still points at the host — a differently
# named drop-in, or a line in /etc/apt/sources.list — this lane is still exposed
# and the right time to learn that is now, by name, not on some future morning
# as a red `apt-get update` on an unrelated PR.
search_paths=()
if [ -f /etc/apt/sources.list ]; then
  search_paths+=(/etc/apt/sources.list)
fi
if [ -d /etc/apt/sources.list.d ]; then
  search_paths+=(/etc/apt/sources.list.d)
fi

if [ "${#search_paths[@]}" -gt 0 ]; then
  grep_status=0
  leftovers="$(grep -RIl -- "${UNUSED_SOURCE_HOST}" "${search_paths[@]}")" || grep_status=$?
  case "${grep_status}" in
    0)
      echo "drop-unused-sources: ${UNUSED_SOURCE_HOST} is STILL configured in:" >&2
      echo "${leftovers}" >&2
      exit 1
      ;;
    1) ;; # no match: the source is gone, which is the whole point
    *)
      echo "drop-unused-sources: could not scan apt sources (grep exit ${grep_status})" >&2
      exit "${grep_status}"
      ;;
  esac

  echo "drop-unused-sources: apt sources now configured:"
  find "${search_paths[@]}" -type f -print
fi
